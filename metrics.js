// Generation counters and per-attempt outcome tracking.
// Pure module (no SillyTavern imports) so it can be unit tested in Node.
//
// Stored per usage entry: messageCount (recorded generations, including stopped
// ones), stopped, failed. Everything else is derived by generationStats().

/**
 * Add generation counters to a usage entry. Missing fields count as 0.
 * @param {object} entry Usage entry (bucket or nested model/source entry)
 * @param {{messageCount?: number, stopped?: number, failed?: number}} counts
 * @returns {object} The same entry
 */
export function bumpCounts(entry, { messageCount = 0, stopped = 0, failed = 0 } = {}) {
    if (messageCount) entry.messageCount = (entry.messageCount || 0) + messageCount;
    if (stopped) entry.stopped = (entry.stopped || 0) + stopped;
    if (failed) entry.failed = (entry.failed || 0) + failed;
    return entry;
}

/**
 * Derive generation statistics from a usage entry.
 * @param {object} [entry]
 * @returns {{generations: number, stopped: number, failed: number, succeeded: number, attempts: number, successRate: number|null}}
 */
export function generationStats(entry) {
    const generations = entry?.messageCount || 0;
    const stopped = entry?.stopped || 0;
    const failed = entry?.failed || 0;
    const attempts = generations + failed;
    const succeeded = Math.max(0, generations - stopped);
    return {
        generations,
        stopped,
        failed,
        succeeded,
        attempts,
        successRate: attempts > 0 ? succeeded / attempts : null,
    };
}

/**
 * Whether a day/hour bucket began after outcome tracking started, i.e. its
 * stopped/failed counts cover the whole period. Keys are zero-padded
 * (YYYY-MM-DD or YYYY-MM-DDTHH), so string comparison is chronological.
 * @param {string} key Bucket key
 * @param {string|null} sinceKey Key of the bucket in which tracking started
 * @returns {boolean}
 */
export function hasCompleteOutcomes(key, sinceKey) {
    return typeof key === 'string' && typeof sinceKey === 'string' && key > sinceKey;
}

/**
 * Generation values for one chart point.
 * @param {object} [bucket] byDay or byHour bucket
 * @param {string} [sourceFilter] 'all' or a source ID
 * @returns {{generations: number, stopped: number, failed: number, succeeded: number, attempts: number, successRate: number|null, modelCounts: Object<string, number>}}
 */
export function generationPoint(bucket, sourceFilter = 'all') {
    const scope = sourceFilter === 'all' ? bucket : bucket?.sources?.[sourceFilter];
    const modelCounts = {};
    for (const [modelId, modelData] of Object.entries(scope?.models || {})) {
        if (modelData && typeof modelData === 'object' && modelData.messageCount > 0) {
            modelCounts[modelId] = modelData.messageCount;
        }
    }
    return { ...generationStats(scope), modelCounts };
}

/**
 * Y axis scale for count charts: integer steps only.
 * @param {number} maxValue Largest plotted value
 * @returns {{step: number, niceMax: number}}
 */
export function countAxisScale(maxValue) {
    if (!(maxValue > 0)) return { step: 1, niceMax: 5 };
    const roughStep = maxValue / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    let step = Math.ceil(roughStep / magnitude) * magnitude;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    step = Math.max(1, Math.ceil(step));
    return { step, niceMax: Math.ceil(maxValue / step) * step };
}

/**
 * Tracks generation attempts from request to outcome.
 *
 * An attempt is 'main' (normal/swipe/continue/impersonate; SillyTavern runs at
 * most one at a time) or 'quiet' (background; may overlap a main one). Each
 * attempt resolves exactly once as 'succeeded', 'stopped' or 'failed', and
 * onResolve is called synchronously at that moment.
 *
 * @param {object} options
 * @param {(attempt: object, status: string, details: object) => void} options.onResolve
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {number} [options.endedGraceMs] Wait after a generation ends before inferring failure
 * @param {number} [options.pendingSweepAgeMs] Age after which an attempt that never sent a request is failed
 * @param {number} [options.bindWindowMs] Max age of an attempt a request may be bound to
 */
export function createAttemptTracker({
    onResolve,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    endedGraceMs = 2000,
    pendingSweepAgeMs = 10000,
    bindWindowMs = 60000,
} = {}) {
    /** Open attempts in creation order */
    const open = [];
    let nextId = 1;

    function resolve(attempt, status, details = {}) {
        if (!attempt || attempt.status !== 'open') return false;
        attempt.status = status;
        const index = open.indexOf(attempt);
        if (index !== -1) open.splice(index, 1);
        onResolve?.(attempt, status, details);
        return true;
    }

    function oldestOpen(kind) {
        return open.find(attempt => attempt.kind === kind) || null;
    }

    function begin(kind, meta = {}) {
        // An older main attempt must already be finished: it either got a
        // response without a message (tool-call round) or never got one.
        if (kind === 'main') {
            for (const previous of open.filter(attempt => attempt.kind === 'main')) {
                resolve(previous, previous.request === 'ok' ? 'succeeded' : 'failed');
            }
        }
        const attempt = {
            id: nextId++,
            kind,
            meta,
            createdAt: now(),
            request: 'pending',
            streaming: false,
            status: 'open',
        };
        open.push(attempt);
        return attempt;
    }

    function bindRequest({ streaming = false } = {}) {
        const cutoff = now() - bindWindowMs;
        const attempt = open.find(a => a.request === 'pending' && a.createdAt >= cutoff);
        if (!attempt) return null;
        attempt.request = 'sent';
        attempt.streaming = Boolean(streaming);
        return attempt;
    }

    /**
     * Mark an attempt as streaming when that was not visible from its request
     * @param {object} attempt
     */
    function markStreaming(attempt) {
        if (attempt?.status === 'open') attempt.streaming = true;
    }

    function requestSettled(attempt, result, details = {}) {
        if (!attempt || attempt.status !== 'open') return false;
        if (result === 'aborted') return resolve(attempt, 'stopped', details);
        if (result === 'failed') return resolve(attempt, 'failed', details);
        attempt.request = 'ok';
        return true;
    }

    function generationEnded({ streamError = false } = {}) {
        const main = oldestOpen('main');
        if (main && main.streaming && streamError) {
            resolve(main, 'failed');
        }

        // A user stop reports right after this event, so decide only after a grace
        // period. Streaming attempts are left open: their message arrives after it.
        setTimer(() => {
            if (main && main.status === 'open' && !main.streaming && main.request !== 'sent') {
                resolve(main, 'failed');
            }
            const cutoff = now() - pendingSweepAgeMs;
            for (const attempt of open.filter(a => a.request === 'pending' && !a.streaming && a.createdAt <= cutoff)) {
                resolve(attempt, 'failed');
            }
        }, endedGraceMs);
    }

    return {
        begin,
        bindRequest,
        markStreaming,
        requestSettled,
        resolve,
        generationEnded,
        oldestOpen,
        openMain: () => oldestOpen('main'),
        list: () => [...open],
    };
}
