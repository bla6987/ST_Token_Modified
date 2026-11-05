// API error tracking by route: the source, endpoint host, model and provider a
// generation request went to, and whether it returned an error.
// Pure module (no SillyTavern imports) so it can be unit tested in Node.
//
// Stored: { routes: { [key]: route stats }, log: recent errors, oldest first }.

/** Recent errors kept in the log */
export const ERROR_LOG_LIMIT = 100;
/** Routes kept; the least recently used is dropped beyond this */
export const ERROR_ROUTE_LIMIT = 300;
/** Characters kept of an error message */
const MESSAGE_LIMIT = 300;
/** Characters kept of a streamed body that has no SSE event yet (it may be a plain JSON error) */
export const PLAIN_BODY_LIMIT = 64 * 1024;
export const STREAM_FRAME_LIMIT = 256 * 1024;
export const STREAM_DATA_LINE_LIMIT = 4096;
export const ERROR_LABEL_LIMIT = 64;

/**
 * @typedef {object} Route
 * @property {string} source Chat completion source or text completion API type
 * @property {string} host Endpoint host ('' when the source has a fixed endpoint)
 * @property {string} model Model ID
 * @property {string} provider Upstream provider ('' when unknown)
 */

/**
 * @typedef {object} RouteError
 * @property {string} kind 'http' | 'network' | 'response' | 'stream' | 'interrupted' | 'generation'
 * @property {number} [status] HTTP status ('http' only)
 * @property {string} [code] Error code or type from the payload
 * @property {string} message
 */

export function createErrorStore() {
    return { routes: {}, log: [] };
}

/**
 * @param {any} store Stored value
 * @returns {object} The store, or a new one when the value is not a valid store
 */
export function normalizeErrorStore(store) {
    const valid = store && typeof store === 'object'
        && store.routes && typeof store.routes === 'object' && !Array.isArray(store.routes)
        && Array.isArray(store.log);
    if (!valid) return createErrorStore();
    // Scrub old records and imports too, including strings used as grouping keys.
    const routes = Object.create(null);
    for (const [oldKey, stats] of Object.entries(store.routes)) {
        if (!stats || typeof stats !== 'object') continue;
        const key = oldKey.split('|').map(clip).join('|');
        const cleaned = scrubStoredRecord(stats);
        cleaned.ok = Number(cleaned.ok) || 0;
        cleaned.errors = Number(cleaned.errors) || 0;
        if (stats.lastError) cleaned.lastError = scrubStoredRecord(stats.lastError);
        if (stats.byLabel) {
            cleaned.byLabel = {};
            for (const [name, count] of Object.entries(stats.byLabel)) {
                const safeName = clip(name);
                Object.defineProperty(cleaned.byLabel, safeName, {
                    value: (Number(cleaned.byLabel[safeName]) || 0) + (Number(count) || 0),
                    writable: true, enumerable: true, configurable: true,
                });
            }
        }
        if (!routes[key]) {
            routes[key] = cleaned;
        } else {
            const target = routes[key];
            target.ok = (Number(target.ok) || 0) + (Number(cleaned.ok) || 0);
            target.errors = (Number(target.errors) || 0) + (Number(cleaned.errors) || 0);
            target.byLabel ||= {};
            for (const [name, count] of Object.entries(cleaned.byLabel || {})) {
                Object.defineProperty(target.byLabel, name, { value: (Number(target.byLabel[name]) || 0) + count,
                    writable: true, enumerable: true, configurable: true });
            }
            target.lastSeenAt = Math.max(target.lastSeenAt || 0, cleaned.lastSeenAt || 0);
            if (cleaned.lastError && (!target.lastError || cleaned.lastError.at >= target.lastError.at)) {
                target.lastError = cleaned.lastError;
            }
        }
    }
    store.routes = routes;
    store.log = store.log.filter(entry => entry && typeof entry === 'object').slice(-ERROR_LOG_LIMIT)
        .map(scrubStoredRecord);
    for (const stats of Object.values(routes)) pruneErrorLabels(stats);
    pruneRoutes(store, '');
    return store;
}

const text = (value) => typeof value === 'string' ? value.trim() : '';
const label = (value) => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);

/** Redact credentials before clipping, persistence, console output or export. */
export function scrubCredentials(value) {
    let result = String(value ?? '');
    result = result.replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
    // URLs can carry credentials in userinfo, arbitrary query names and fragments.
    result = result.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
        try {
            const url = new URL(raw);
            const hadCredentials = Boolean(url.username || url.password);
            url.username = '';
            url.password = '';
            if (url.search) url.search = '?[REDACTED]';
            if (url.hash) url.hash = '#[REDACTED]';
            return `${hadCredentials ? '[REDACTED]@' : ''}${url.href}`;
        } catch {
            return '[REDACTED URL]';
        }
    });
    // Quoted JSON fields, headers and key=value diagnostics. Never keep a token prefix.
    const field = '(?:authorization|proxy[-_ ]?authorization|(?:x[-_ ])?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|secret|client[-_ ]?secret|password|passwd|cookie|set-cookie)';
    result = result.replace(new RegExp(`(["']?${field}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[^\\\\])*?\\2`, 'gi'), '$1"[REDACTED]"');
    result = result.replace(new RegExp(`(\\b${field}\\b\\s*[:=]\\s*)(?:Bearer\\s+|Basic\\s+)?[^\\s,;"'}]+`, 'gi'), '$1[REDACTED]');
    result = result.replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [REDACTED]');
    result = result.replace(/\b(?:sk-[\w-]+|gsk_[\w-]+|hf_[\w-]+|AIza[\w-]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]');
    return result;
}

function cleanRoute(route) {
    return Object.fromEntries(['source', 'host', 'model', 'provider'].map(key => [key, clip(route[key] || '')]));
}

function scrubStoredRecord(record) {
    const cleaned = { ...record };
    for (const field of ['source', 'host', 'model', 'provider', 'kind', 'code', 'message', 'genType']) {
        if (typeof cleaned[field] === 'string') cleaned[field] = clip(cleaned[field]);
    }
    return cleaned;
}

function cleanErrorEntry(entry) {
    return { at: entry.at, kind: clip(entry.kind || ''), status: entry.status ?? null,
        code: clip(entry.code || ''), message: clip(entry.message || 'Unknown error') };
}

/**
 * Host of an endpoint URL. Never the user info, path or query, which can hold API keys.
 * @param {any} url
 * @returns {string}
 */
function endpointHost(url) {
    if (!text(url)) return '';
    try {
        return new URL(url.trim()).host;
    } catch {
        return '';
    }
}

/**
 * Provider routing the request asked for (OpenRouter provider order, NanoGPT provider)
 * @param {object} body
 * @returns {string}
 */
function requestedProvider(body) {
    if (Array.isArray(body.provider)) return body.provider.filter(x => typeof x === 'string').join(', ');
    return text(body.nanogpt_provider);
}

/** SillyTavern generation endpoints whose request body names the route */
const ROUTE_PARSERS = {
    '/api/backends/chat-completions/generate': body => ({
        source: body.chat_completion_source,
        host: endpointHost(body.custom_url || body.reverse_proxy || body.azure_base_url),
        model: body.model,
        provider: requestedProvider(body),
    }),
    '/api/backends/text-completions/generate': body => ({
        source: body.api_type,
        host: endpointHost(body.api_server),
        model: body.model,
        provider: '',
    }),
};

/**
 * Identify where a generation request goes from its parsed JSON body
 * @param {string} path Request path
 * @param {any} body Parsed request body
 * @returns {Route|null} null for other endpoints
 */
export function routeFromRequest(path, body) {
    const parse = ROUTE_PARSERS[path];
    if (!parse || !body || typeof body !== 'object') return null;
    const route = parse(body);
    return {
        source: text(route.source) || 'unknown',
        host: text(route.host),
        model: text(route.model) || 'unknown',
        provider: text(route.provider),
    };
}

/**
 * @param {Route} route
 * @returns {string} Storage key of the route
 */
export function routeKey(route) {
    return [route.source, route.host, route.model, route.provider].join('|');
}

/**
 * Upstream provider that served or failed a request, when the payload names it
 * (OpenRouter: `provider` on responses, `error.metadata.provider_name` on errors)
 * @param {any} data Parsed payload
 * @returns {string}
 */
export function payloadProvider(data) {
    if (!data || typeof data !== 'object') return '';
    return text(data.provider) || text(data.error?.metadata?.provider_name);
}

/** Tool-only completions are valid even when they contain no assistant text. */
export function payloadHasToolCalls(data) {
    return Boolean((Array.isArray(data?.choices) && data.choices.some(choice => choice?.message?.tool_calls?.length
        || choice?.message?.function_call || choice?.delta?.tool_calls?.length || choice?.delta?.function_call))
        || data?.content_block?.type === 'tool_use'
        || (Array.isArray(data?.content) && data.content.some(block => block?.type === 'tool_use'))
        || (Array.isArray(data?.candidates) && data.candidates.some(candidate =>
            Array.isArray(candidate?.content?.parts) && candidate.content.parts.some(part => part?.functionCall))));
}

/**
 * Collapse whitespace, drop HTML tags and shorten a message
 * @param {string} message
 * @returns {string}
 */
function clip(message) {
    let result = scrubCredentials(message);
    if (/<\/?[a-z][^>]*>/i.test(result)) result = result.replace(/<[^>]*>/g, ' ');
    result = result.replace(/\s+/g, ' ').trim();
    return result.length > MESSAGE_LIMIT ? `${result.slice(0, MESSAGE_LIMIT - 1)}…` : result;
}

/**
 * Describe an error body of any known shape: {error: {message, code, type}},
 * {error: 'text'}, {message}, {detail}, or plain text
 * @param {any} data Parsed payload or raw text
 * @param {string} [fallback] Message when the body has none (e.g. the HTTP status text)
 * @returns {{message: string, code: string}}
 */
export function describeError(data, fallback = '') {
    const error = data?.error;
    let message = text(error?.message)
        || text(error)
        || text(data?.message)
        || text(data?.detail?.error?.message)
        || text(data?.detail)
        || text(data)
        || text(fallback)
        || 'Unknown error';
    // OpenRouter puts the upstream provider's own error in metadata.raw
    const raw = text(error?.metadata?.raw);
    if (raw && !message.includes(raw)) message = `${message}: ${raw}`;
    const code = label(error?.code) || text(error?.type) || label(data?.code);
    return { message: clip(message), code: clip(code) };
}

/** HTTP reason phrases, by lower-cased phrase */
const STATUS_BY_REASON = Object.fromEntries(Object.entries({
    400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large',
    422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented',
    502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}).map(([status, reason]) => [reason.toLowerCase(), Number(status)]));

/**
 * HTTP status named by an error message that is only a reason phrase. SillyTavern answers
 * a failed non-streaming OpenAI-compatible request with HTTP 200 and the upstream's
 * status text (e.g. "Too Many Requests") as the message.
 * @param {string} message
 * @returns {number|null}
 */
export function statusFromReason(message) {
    return STATUS_BY_REASON[text(message).toLowerCase()] ?? null;
}

/**
 * The error in a successful (HTTP 200) payload, or null when it is not an error.
 * Only `error` counts: chunks of some streaming formats carry unrelated `message` fields.
 * @param {any} data Parsed payload
 * @returns {{message: string, code: string}|null}
 */
export function payloadError(data) {
    if (!data || typeof data !== 'object' || !data.error) return null;
    return describeError(data);
}

/**
 * Scan a streamed (SSE) response body for error events, as SillyTavern reads it.
 * SillyTavern only shows a toast for an error event and then finishes the stream
 * as if it succeeded.
 */
export function createStreamScanner({ onData = null } = {}) {
    let terminal = false;
    let buffer = '';
    let dataLines = [];
    let dataChars = 0;
    let events = 0;
    let plain = '';
    let provider = '';
    let hasToolCalls = false;
    let discardLine = false;
    let discardEvent = false;
    let oversizedFrames = 0;

    function discardOversizedEvent() {
        if (!discardEvent) oversizedFrames++;
        discardEvent = true;
        dataLines = [];
        dataChars = 0;
        plain = '';
    }

    function addError(errors, error) {
        // A single huge network chunk can contain many invalid events.
        if (errors.length < 32) errors.push(error);
    }

    function dispatch(errors) {
        if (discardEvent) {
            discardEvent = false;
            events++;
            return;
        }
        if (!dataLines.length) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        dataChars = 0;
        plain = '';
        events++;
        if (raw === '[DONE]') { terminal = true; return; }
        let data;
        try { data = JSON.parse(raw); } catch {
            addError(errors, { message: clip(raw) || 'Invalid stream event', code: '' });
            return;
        }
        onData?.(data);
        provider ||= payloadProvider(data);
        hasToolCalls ||= payloadHasToolCalls(data);
        const error = payloadError(data);
        if (error) addError(errors, error);
    }

    function processLine(line, errors) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') return dispatch(errors);
        if (discardEvent || line.startsWith(':')) return;
        const colon = line.indexOf(':');
        if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') return;
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (dataChars + value.length + 1 > STREAM_FRAME_LIMIT || dataLines.length >= STREAM_DATA_LINE_LIMIT) {
            discardOversizedEvent();
            return;
        }
        dataLines.push(value);
        dataChars += value.length + 1;
    }

    return {
        push(chunk) {
            const errors = [];
            if (!events && !discardEvent && plain.length < PLAIN_BODY_LIMIT) {
                plain += chunk.slice(0, PLAIN_BODY_LIMIT - plain.length);
            }
            // Do not append/split the whole chunk. Even a single network chunk or
            // a line without a newline must respect the frame cap.
            let offset = 0;
            while (offset < chunk.length) {
                const newline = chunk.indexOf('\n', offset);
                const end = newline === -1 ? chunk.length : newline;
                if (!discardLine) {
                    if (buffer.length + end - offset + dataChars > STREAM_FRAME_LIMIT) {
                        buffer = '';
                        discardLine = true;
                        discardOversizedEvent();
                    } else {
                        buffer += chunk.slice(offset, end);
                    }
                }
                if (newline === -1) break;
                if (!discardLine) processLine(buffer, errors);
                buffer = '';
                discardLine = false;
                offset = newline + 1;
            }
            return errors;
        },
        finish() {
            const errors = [];
            if (buffer && !discardLine) processLine(buffer, errors);
            buffer = '';
            discardLine = false;
            dispatch(errors);
            if (!events && plain.trim()) {
                let data = null;
                try { data = JSON.parse(plain); } catch { /* incomplete/plain text */ }
                if (data && typeof data === 'object' && (data.error || data.message || data.detail)) {
                    addError(errors, describeError(data));
                }
            }
            plain = '';
            return errors;
        },
        get done() { return terminal; },
        get provider() { return provider; },
        get hasToolCalls() { return hasToolCalls; },
        // Oversized diagnostic events are skipped, never invented API failures.
        get oversizedFrames() { return oversizedFrames; },
        get bufferedChars() { return buffer.length + dataChars + plain.length; },
    };
}

/**
 * Short label of an error for grouping: its HTTP status, else its code, else its kind
 * @param {RouteError} error
 * @returns {string}
 */
export function errorLabel(error) {
    return label(error?.status) || text(error?.code) || text(error?.kind) || 'error';
}

/** Keep a bounded label breakdown while preserving the total error count. */
function pruneErrorLabels(stats) {
    const labels = Object.entries(stats.byLabel || {});
    if (labels.length <= ERROR_LABEL_LIMIT) return;
    labels.sort((a, b) => Number(b[1]) - Number(a[1]));
    const kept = Object.create(null);
    let other = 0;
    for (const [name, count] of labels) {
        if (name !== 'other' && Object.keys(kept).length < ERROR_LABEL_LIMIT - 1) kept[name] = Number(count) || 0;
        else other += Number(count) || 0;
    }
    kept.other = other;
    stats.byLabel = kept;
}

/** Drop the least recently used routes beyond the limit, except the one just used. */
function pruneRoutes(store, keepKey) {
    const keys = Object.keys(store.routes);
    let excess = keys.length - ERROR_ROUTE_LIMIT;
    if (excess <= 0) return;
    const byAge = keys.filter(key => key !== keepKey)
        .sort((a, b) => (store.routes[a].lastSeenAt || 0) - (store.routes[b].lastSeenAt || 0));
    for (const key of byAge) {
        if (excess-- <= 0) break;
        delete store.routes[key];
    }
}

/**
 * Record how one request to a route ended
 * @param {object} store Error store
 * @param {Route} route
 * @param {RouteError|null} error null for success
 * @param {object} [options]
 * @param {number} [options.now] Timestamp (ms)
 * @param {string} [options.genType] Generation type, when known
 * @returns {object} The route's stats
 */
export function recordRouteOutcome(store, route, error, { now = Date.now(), genType = '' } = {}) {
    route = cleanRoute(route);
    const key = routeKey(route);
    let stats = store.routes[key];
    if (!stats) {
        stats = store.routes[key] = { ...route, ok: 0, errors: 0, byLabel: {}, lastError: null };
        pruneRoutes(store, key);
    }
    stats.lastSeenAt = now;

    if (!error) {
        stats.ok++;
        return stats;
    }

    const entry = {
        ...cleanErrorEntry(error),
        at: now,
    };
    const errorKey = errorLabel(entry);
    stats.errors++;
    Object.defineProperty(stats.byLabel, errorKey, { value: (Number(stats.byLabel[errorKey]) || 0) + 1,
        writable: true, enumerable: true, configurable: true });
    stats.lastError = entry;
    pruneErrorLabels(stats);

    store.log.push({ ...route, ...entry, genType: clip(genType) });
    if (store.log.length > ERROR_LOG_LIMIT) store.log.splice(0, store.log.length - ERROR_LOG_LIMIT);
    return stats;
}

/** Replace a provisional lifecycle error with the detailed error for the same request. */
export function retractRouteError(store, logEntry) {
    const index = store.log.indexOf(logEntry);
    if (index === -1) return false; // Cleared/imported/pruned records must not affect new counts.
    store.log.splice(index, 1);
    const stats = store.routes[routeKey(logEntry)];
    if (!stats) return true;
    stats.errors = Math.max(0, stats.errors - 1);
    const name = errorLabel(logEntry);
    if (stats.byLabel[name] > 1) stats.byLabel[name]--;
    else if (stats.byLabel[name] === 1) delete stats.byLabel[name];
    else if (stats.byLabel.other > 1) stats.byLabel.other--;
    else delete stats.byLabel.other;
    stats.lastError = store.log.slice().reverse().find(entry => routeKey(entry) === routeKey(logEntry)) || null;
    if (!stats.ok && !stats.errors) delete store.routes[routeKey(logEntry)];
    return true;
}

/**
 * Routes that returned at least one error, most errors first
 * @param {object} store
 * @returns {Array<object>} Route stats with key, attempts and errorRate
 */
export function erroringRoutes(store) {
    return Object.entries(store?.routes || {})
        .filter(([, stats]) => stats?.errors > 0)
        .map(([key, stats]) => {
            // Numeric: counts are rendered as HTML
            const errors = Number(stats.errors);
            const attempts = (Number(stats.ok) || 0) + errors;
            return { ...stats, key, errors, attempts, errorRate: errors / attempts };
        })
        .sort((a, b) => b.errors - a.errors || (b.lastError?.at || 0) - (a.lastError?.at || 0));
}

/**
 * Error labels of a route, most frequent first
 * @param {object} stats Route stats
 * @returns {Array<[string, number]>}
 */
export function errorBreakdown(stats) {
    return Object.entries(stats?.byLabel || {}).sort((a, b) => b[1] - a[1]);
}
