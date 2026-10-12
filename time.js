/** A shared, bounded time sync for usage timestamps. Dates remain absolute UTC instants. */
export function createUsageClock({
    timeZone = 'America/New_York',
    fetchFn = (...args) => fetch(...args),
    wallNow = () => Date.now(),
    elapsedNow = () => performance.now(),
    intervalMs = 5 * 60 * 1000,
    timeoutMs = 3000,
    logger = console,
} = {}) {
    let offset = 0;
    let lastAttempt = null;
    let inFlight = null;

    function sync() {
        if (inFlight) return inFlight;
        const elapsed = elapsedNow();
        // Failed attempts also wait for the interval; timestamp reads must not flood the service.
        if (lastAttempt !== null && elapsed - lastAttempt < intervalMs) {
            return Promise.resolve(false);
        }
        lastAttempt = elapsed;
        const startedAt = wallNow();
        // Defer the request so inFlight is assigned even if fetchFn throws synchronously.
        inFlight = Promise.resolve().then(async () => {
            try {
                const response = await fetchFn(`https://worldtimeapi.org/api/timezone/${timeZone}`, {
                    signal: AbortSignal.timeout(timeoutMs),
                    cache: 'no-store',
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                // Prefer sub-second datetime precision; unixtime is usually whole seconds.
                const preciseTime = typeof data?.datetime === 'string' ? Date.parse(data.datetime) : NaN;
                const externalTime = Number.isFinite(preciseTime) ? preciseTime
                    : typeof data?.unixtime === 'number' ? data.unixtime * 1000 : NaN;
                if (!Number.isFinite(externalTime) || !Number.isFinite(new Date(externalTime).getTime())) {
                    throw new Error('Invalid datetime from external time source');
                }
                const finishedAt = wallNow();
                // Estimate the local time at the server's sample, rather than subtracting
                // the arrival time and turning request latency into clock drift.
                offset = externalTime - (startedAt + finishedAt) / 2;
                logger.log(`[Token Usage Tracker] Time synced with external source. Offset: ${offset}ms`);
                return true;
            } catch (error) {
                logger.warn('[Token Usage Tracker] Failed to fetch external time:', error.message);
                // Keep the last good offset, or the local clock if there has been no success.
                return false;
            } finally {
                lastAttempt = elapsedNow();
                inFlight = null;
            }
        });
        return inFlight;
    }

    function now() {
        void sync();
        return new Date(wallNow() + offset);
    }

    return { now, sync };
}
