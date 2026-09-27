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
const PLAIN_BODY_LIMIT = 64 * 1024;

/**
 * @typedef {object} Route
 * @property {string} source Chat completion source or text completion API type
 * @property {string} host Endpoint host ('' when the source has a fixed endpoint)
 * @property {string} model Model ID
 * @property {string} provider Upstream provider ('' when unknown)
 */

/**
 * @typedef {object} RouteError
 * @property {string} kind 'http' | 'network' | 'response' | 'stream' | 'interrupted'
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
    return valid ? store : createErrorStore();
}

const text = (value) => typeof value === 'string' ? value.trim() : '';
const label = (value) => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);

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

/**
 * Collapse whitespace, drop HTML tags and shorten a message
 * @param {string} message
 * @returns {string}
 */
function clip(message) {
    let result = String(message);
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
    return { message: clip(message), code };
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
export function createStreamScanner() {
    let buffer = '';
    let dataLines = [];
    let events = 0;
    let plain = '';
    let provider = '';

    function dispatch(errors) {
        if (!dataLines.length) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        events++;
        if (raw === '[DONE]') return;
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            // SillyTavern fails the stream on an event that is not JSON
            errors.push({ message: clip(raw) || 'Invalid stream event', code: '' });
            return;
        }
        provider ||= payloadProvider(data);
        const error = payloadError(data);
        if (error) errors.push(error);
    }

    function processLine(line, errors) {
        if (line === '') return dispatch(errors);
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') return;
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        dataLines.push(value);
    }

    return {
        /**
         * @param {string} chunk Decoded body text
         * @returns {Array<{message: string, code: string}>} Errors in the events completed by this chunk
         */
        push(chunk) {
            const errors = [];
            if (!events && plain.length < PLAIN_BODY_LIMIT) plain += chunk;
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) processLine(line, errors);
            return errors;
        },
        /**
         * @returns {Array<{message: string, code: string}>} Errors in the rest of the body
         */
        finish() {
            const errors = [];
            if (buffer) processLine(buffer, errors);
            buffer = '';
            dispatch(errors);
            if (!events && plain.trim()) {
                // Not an event stream: the server answered with a plain body, usually a JSON error
                let data = null;
                try {
                    data = JSON.parse(plain);
                } catch {
                    // Not JSON either
                }
                if (data && typeof data === 'object' && (data.error || data.message || data.detail)) {
                    errors.push(describeError(data));
                }
            }
            return errors;
        },
        /** Upstream provider named by the stream */
        get provider() {
            return provider;
        },
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

/**
 * Drop the least recently used routes beyond the limit, never the one just used
 * @param {object} store
 * @param {string} keepKey
 */
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
        at: now,
        kind: error.kind,
        status: error.status ?? null,
        code: error.code || '',
        message: clip(error.message || 'Unknown error'),
    };
    const errorKey = errorLabel(error);
    stats.errors++;
    stats.byLabel[errorKey] = (stats.byLabel[errorKey] || 0) + 1;
    stats.lastError = entry;

    store.log.push({ ...route, ...entry, genType });
    if (store.log.length > ERROR_LOG_LIMIT) store.log.splice(0, store.log.length - ERROR_LOG_LIMIT);
    return stats;
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
            const attempts = (stats.ok || 0) + stats.errors;
            return { ...stats, key, attempts, errorRate: stats.errors / attempts };
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
