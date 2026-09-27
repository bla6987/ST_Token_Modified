import test from 'node:test';
import assert from 'node:assert/strict';
import * as errors from '../errors.js';

const CHAT = '/api/backends/chat-completions/generate';

test('routes come from chat completion bodies, keeping only the endpoint host', () => {
    assert.deepEqual(errors.routeFromRequest(CHAT, {
        chat_completion_source: 'custom',
        model: 'glm-4.6',
        custom_url: 'https://user:secret@api.example.com:8443/v1?key=abc',
    }), { source: 'custom', host: 'api.example.com:8443', model: 'glm-4.6', provider: '' });

    assert.deepEqual(errors.routeFromRequest(CHAT, {
        chat_completion_source: 'openrouter', model: 'deepseek/deepseek-chat', provider: ['DeepInfra', 'Together'],
    }), { source: 'openrouter', host: '', model: 'deepseek/deepseek-chat', provider: 'DeepInfra, Together' });

    assert.equal(errors.routeFromRequest(CHAT, { chat_completion_source: 'nanogpt', model: 'x', nanogpt_provider: 'Chutes' }).provider, 'Chutes');
    assert.equal(errors.routeFromRequest(CHAT, { chat_completion_source: 'openai', model: 'x', reverse_proxy: 'https://proxy.test/v1' }).host, 'proxy.test');
    assert.equal(errors.routeFromRequest(CHAT, { chat_completion_source: 'custom', model: 'x', custom_url: 'not a url' }).host, '');
    assert.deepEqual(errors.routeFromRequest(CHAT, {}), { source: 'unknown', host: '', model: 'unknown', provider: '' });
});

test('routes come from text completion bodies; other endpoints and bodies have none', () => {
    assert.deepEqual(errors.routeFromRequest('/api/backends/text-completions/generate', {
        api_type: 'koboldcpp', api_server: 'http://127.0.0.1:5001', model: 'mistral-7b',
    }), { source: 'koboldcpp', host: '127.0.0.1:5001', model: 'mistral-7b', provider: '' });
    assert.equal(errors.routeFromRequest('/api/novelai/generate', { model: 'kayra' }), null);
    assert.equal(errors.routeFromRequest(CHAT, null), null);
    assert.equal(errors.routeFromRequest(CHAT, 'text'), null);
});

test('describeError reads every error body shape SillyTavern forwards', () => {
    assert.deepEqual(errors.describeError({ error: { message: 'Rate limited', code: 429 } }), { message: 'Rate limited', code: '429' });
    assert.deepEqual(errors.describeError({ error: { message: 'Bad key', type: 'invalid_request_error' } }), { message: 'Bad key', code: 'invalid_request_error' });
    assert.equal(errors.describeError({ error: 'Model not found' }).message, 'Model not found');
    assert.equal(errors.describeError({ message: 'Overloaded' }).message, 'Overloaded');
    assert.equal(errors.describeError({ detail: { error: { message: 'Nested' } } }).message, 'Nested');
    assert.equal(errors.describeError({ detail: 'Not Found' }).message, 'Not Found');
    assert.equal(errors.describeError({ error: true }, 'Bad Gateway').message, 'Bad Gateway');
    assert.equal(errors.describeError({}).message, 'Unknown error');
    assert.equal(errors.describeError('<html><head><title>502 Bad Gateway</title></head><body><h1>Oops</h1></body></html>').message, '502 Bad Gateway Oops');
    assert.equal(errors.describeError({
        error: { code: 502, message: 'Provider returned error', metadata: { provider_name: 'Together', raw: 'upstream timeout' } },
    }).message, 'Provider returned error: upstream timeout');
    assert.equal(errors.describeError({ error: { message: 'x'.repeat(1000) } }).message.length, 300);
});

test('only an error field marks a successful payload as an error', () => {
    assert.equal(errors.payloadError({ choices: [] }), null);
    assert.equal(errors.payloadError({ type: 'message_start', message: { id: 'msg_1' } }), null);
    assert.equal(errors.payloadError(null), null);
    assert.deepEqual(errors.payloadError({ error: { message: 'Too Many Requests' }, quota_error: false }), { message: 'Too Many Requests', code: '' });
    assert.equal(errors.payloadProvider({ provider: 'Fireworks', choices: [] }), 'Fireworks');
    assert.equal(errors.payloadProvider({ error: { metadata: { provider_name: 'Together' } } }), 'Together');
    assert.equal(errors.payloadProvider({ provider: { name: 'object' } }), '');
});

test('a message that is only an HTTP reason phrase names its status', () => {
    assert.equal(errors.statusFromReason('Too Many Requests'), 429);
    assert.equal(errors.statusFromReason(' bad gateway '), 502);
    assert.equal(errors.statusFromReason('Too Many Requests for this model'), null);
    assert.equal(errors.statusFromReason(undefined), null);
});

test('stream scanner finds error events split across chunks and ignores comments', () => {
    const scanner = errors.createStreamScanner();
    assert.deepEqual(scanner.push(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Hi"}}],"prov'), []);
    assert.deepEqual(scanner.push('ider":"Together"}\r\n\r\ndata: {"error":{"code":502,'), []);
    assert.deepEqual(scanner.push('"message":"Provider returned error"}}\n\n'), [{ message: 'Provider returned error', code: '502' }]);
    assert.deepEqual(scanner.push('data: [DONE]\n\n'), []);
    assert.deepEqual(scanner.finish(), []);
    assert.equal(scanner.provider, 'Together');
});

test('stream scanner joins multi-line data, and flags events that are not JSON', () => {
    const scanner = errors.createStreamScanner();
    assert.deepEqual(scanner.push('event: error\ndata: {"type":"error",\ndata: "error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'),
        [{ message: 'Overloaded', code: 'overloaded_error' }]);
    assert.deepEqual(scanner.push('data: upstream exploded'), []);
    assert.deepEqual(scanner.finish(), [{ message: 'upstream exploded', code: '' }]);
});

test('stream scanner reads a plain JSON error body sent instead of an event stream', () => {
    const scanner = errors.createStreamScanner();
    scanner.push('{"error":{"message":"Invalid model"');
    scanner.push('}}');
    assert.deepEqual(scanner.finish(), [{ message: 'Invalid model', code: '' }]);

    const empty = errors.createStreamScanner();
    assert.deepEqual(empty.finish(), []);
    const html = errors.createStreamScanner();
    html.push('<html>not an event stream</html>');
    assert.deepEqual(html.finish(), []);
});

test('route outcomes count successes and errors by label and keep a capped log', () => {
    const store = errors.createErrorStore();
    const route = { source: 'custom', host: 'api.example.com', model: 'm', provider: '' };
    errors.recordRouteOutcome(store, route, null, { now: 1 });
    errors.recordRouteOutcome(store, route, { kind: 'http', status: 429, message: 'Rate limited' }, { now: 2, genType: 'swipe' });
    errors.recordRouteOutcome(store, route, { kind: 'stream', code: 'overloaded_error', message: 'Overloaded' }, { now: 3 });
    errors.recordRouteOutcome(store, route, { kind: 'network', message: 'Failed to fetch' }, { now: 4 });

    const stats = store.routes['custom|api.example.com|m|'];
    assert.equal(stats.ok, 1);
    assert.equal(stats.errors, 3);
    assert.deepEqual(stats.byLabel, { 429: 1, overloaded_error: 1, network: 1 });
    assert.deepEqual(stats.lastError, { at: 4, kind: 'network', status: null, code: '', message: 'Failed to fetch' });
    assert.deepEqual(store.log[0], { ...route, at: 2, kind: 'http', status: 429, code: '', message: 'Rate limited', genType: 'swipe' });

    for (let i = 0; i < errors.ERROR_LOG_LIMIT + 10; i++) {
        errors.recordRouteOutcome(store, route, { kind: 'network', message: `e${i}` }, { now: 10 + i });
    }
    assert.equal(store.log.length, errors.ERROR_LOG_LIMIT);
    assert.equal(store.log.at(-1).message, `e${errors.ERROR_LOG_LIMIT + 9}`);
});

test('the least recently used routes are dropped beyond the limit', () => {
    const store = errors.createErrorStore();
    for (let i = 0; i <= errors.ERROR_ROUTE_LIMIT; i++) {
        errors.recordRouteOutcome(store, { source: 'custom', host: '', model: `m${i}`, provider: '' }, null, { now: i === 0 ? 10_000 : i });
    }
    const keys = Object.keys(store.routes);
    assert.equal(keys.length, errors.ERROR_ROUTE_LIMIT);
    assert.ok(keys.includes('custom||m0|'), 'recently used route is kept');
    assert.ok(!keys.includes('custom||m1|'), 'oldest route is dropped');
    assert.ok(keys.includes(`custom||m${errors.ERROR_ROUTE_LIMIT}|`), 'new route is kept');
});

test('erroring routes are sorted by error count with their rate and breakdown', () => {
    const store = errors.createErrorStore();
    const a = { source: 'custom', host: 'a.test', model: 'a', provider: '' };
    const b = { source: 'openrouter', host: '', model: 'b', provider: 'Together' };
    const healthy = { source: 'custom', host: 'c.test', model: 'c', provider: '' };
    errors.recordRouteOutcome(store, a, { kind: 'http', status: 500, message: 'x' }, { now: 1 });
    errors.recordRouteOutcome(store, a, null, { now: 2 });
    errors.recordRouteOutcome(store, b, { kind: 'http', status: 429, message: 'x' }, { now: 3 });
    errors.recordRouteOutcome(store, b, { kind: 'http', status: 429, message: 'x' }, { now: 4 });
    errors.recordRouteOutcome(store, b, { kind: 'stream', message: 'x' }, { now: 5 });
    errors.recordRouteOutcome(store, healthy, null, { now: 6 });

    const routes = errors.erroringRoutes(store);
    assert.deepEqual(routes.map(r => r.model), ['b', 'a']);
    assert.equal(routes[0].attempts, 3);
    assert.equal(routes[0].errorRate, 1);
    assert.equal(routes[1].errorRate, 0.5);
    assert.deepEqual(errors.errorBreakdown(routes[0]), [['429', 2], ['stream', 1]]);
    assert.deepEqual(errors.erroringRoutes(undefined), []);
});

test('stored values that are not a valid store are replaced', () => {
    const store = { routes: {}, log: [] };
    assert.equal(errors.normalizeErrorStore(store), store);
    assert.deepEqual(errors.normalizeErrorStore(undefined), { routes: {}, log: [] });
    assert.deepEqual(errors.normalizeErrorStore({ routes: [], log: [] }), { routes: {}, log: [] });
    assert.deepEqual(errors.normalizeErrorStore({ routes: {} }), { routes: {}, log: [] });
});
