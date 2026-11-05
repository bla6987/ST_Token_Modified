import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as errors from '../errors.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function extract(name) {
    const match = source.match(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(match, name);
    return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

function runtime(mode = 'none', attempt = null) {
    const routes = [];
    const outcomes = [];
    let interceptor;
    let requestParses = 0;
    let sharedParses = 0;
    let response = Response.json({ choices: [{ message: { content: 'reply' } }] });
    const baseFetch = async () => { if (response instanceof Error) throw response; return response; };
    const window = { fetch: baseFetch, location: { origin: 'http://localhost:8000' } };
    if (mode !== 'none') window.STRuntimeBus = { fetch: { registerInterceptor(spec) { interceptor = spec; return () => {}; } } };
    const context = vm.createContext({ usageRevision: 0, ...errors, window, URL, TextDecoder, streamingProcessor: null,
        TOKEN_USAGE_FETCH_PATCHED: Symbol.for('tokenUsageTrackerFetchPatched'),
        GENERATION_REQUEST_PATHS: new Set(['/api/backends/chat-completions/generate']),
        JSON: { stringify: JSON.stringify, parse(value) {
            if (value.includes('"request_marker"')) requestParses++;
            return JSON.parse(value);
        } },
        console: { log() {}, warn() {}, error(...args) { throw new Error(args.join(' ')); } },
        attemptTracker: { bindRequest: () => attempt, requestSettled() {}, resolve(value, status, details) {
            outcomes.push({ attempt: value, status, details });
        } },
        extractResponseText: data => data?.choices?.[0]?.message?.content || '',
        extractResponseReasoning: async data => data?.choices?.[0]?.message?.reasoning || '',
        recordRouteResult(observation, error, provider) { routes.push({ observation, error, provider }); },
    });
    for (const name of ['installGenerationRequestObserver', 'observeGenerationRequest', 'parseRequestBody',
        'isAbortedRequest', 'observeGenerationResponse', 'readInspectionBody', 'inspectResponse', 'recordHttpError', 'watchStreamedResponse']) {
        vm.runInContext(extract(name), context);
    }
    context.installGenerationRequestObserver();
    return { context, routes, outcomes, parses: () => ({ local: requestParses, shared: sharedParses }),
        respond(value) { response = value; },
        async settle() { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); },
        async send(body = {}, path = '/api/backends/chat-completions/generate') {
            const value = { request_marker: true, messages: [{ role: 'user', content: 'prompt' }], ...body };
            const init = { method: 'POST', body: JSON.stringify(value) };
            if (!interceptor) return window.fetch(path, init);
            const req = { target: path, options: init, meta: {} };
            if (mode === 'new') req.getRequestJson = () => { sharedParses++; return value; };
            interceptor.requestObserve(req);
            try {
                const result = await baseFetch();
                interceptor.responseObserve({ request: req, response: result });
                return result;
            } catch (error) {
                interceptor.errorObserve({ request: req, error });
                throw error;
            }
        },
    };
}

for (const mode of ['none', 'old', 'new']) {
    test(`${mode} bus: request parsing is optional/shared and does not consume the returned response`, async () => {
        const h = runtime(mode);
        const original = Response.json({ choices: [{ message: { content: 'caller result' } }] });
        h.respond(original);
        const result = await h.send({ model: 'm', chat_completion_source: 'custom', custom_url: 'https://provider.test/v1' });
        assert.equal(result, original);
        assert.equal((await result.json()).choices[0].message.content, 'caller result');
        await h.settle();
        assert.deepEqual(h.parses(), mode === 'new' ? { local: 0, shared: 1 } : { local: 1, shared: 0 });
        const observation = h.routes[0].observation;
        assert.equal('body' in observation, false);
        assert.equal(JSON.stringify(observation).includes('prompt'), false);
        const before = h.parses();
        h.respond(Response.json({ ok: true }));
        await h.send({}, '/api/status');
        assert.deepEqual(h.parses(), before);
    });

    test(`${mode} bus: network errors are observed without replacing the caller's rejection`, async () => {
        const h = runtime(mode);
        const failure = new Error('network unavailable');
        h.respond(failure);
        await assert.rejects(h.send(), error => error === failure);
        await h.settle();
        assert.equal(h.routes[0].error.kind, 'network');
    });
}

test('main-response and HTTP-error diagnostic readers have hard byte caps', async () => {
    const h = runtime();
    const text = 'x'.repeat(2 * 1024 * 1024);
    const original = new Response(text);
    const inspected = await h.context.readInspectionBody(original.clone(), 64 * 1024);
    assert.equal(inspected.truncated, true);
    assert.equal(inspected.text.length, 64 * 1024);
    assert.equal((await original.text()).length, text.length);
});

test('quiet output remains complete above the diagnostic cap, without retaining responseData', async () => {
    const attempt = { kind: 'quiet', meta: {} };
    const h = runtime('new', attempt);
    const text = 'long output '.repeat(50000);
    h.respond(Response.json({ choices: [{ message: { content: text, reasoning: 'reasoning' } }], unused: 'metadata'.repeat(1000) }));
    const response = await h.send();
    await response.text();
    await h.settle();
    assert.equal(h.outcomes[0].status, 'succeeded');
    assert.equal(h.outcomes[0].details.text.length, text.length);
    assert.equal(h.outcomes[0].details.reasoning, 'reasoning');
    assert.equal('responseData' in h.outcomes[0].details, false);
});

test('single huge chunks and newline-free frames are bounded and later errors still detected', () => {
    for (const chunks of [[`data: ${'x'.repeat(2 * 1024 * 1024)}`], Array(100).fill('x'.repeat(8192))]) {
        const scanner = errors.createStreamScanner();
        for (const chunk of chunks) {
            assert.deepEqual(scanner.push(chunk), []);
            assert.ok(scanner.bufferedChars <= errors.STREAM_FRAME_LIMIT + errors.PLAIN_BODY_LIMIT);
        }
        assert.equal(scanner.oversizedFrames, 1);
        const detected = scanner.push('\n\ndata: {"error":{"message":"rate limited","code":429}}\n\n');
        assert.equal(detected[0].code, '429');
        scanner.finish();
        assert.equal(scanner.bufferedChars, 0);
    }
});

test('multi-line data arrays and per-chunk error arrays are bounded', () => {
    const scanner = errors.createStreamScanner();
    assert.deepEqual(scanner.push('data:\n'.repeat(errors.STREAM_DATA_LINE_LIMIT + 10) + '\n'), []);
    assert.equal(scanner.oversizedFrames, 1);
    const found = scanner.push('data: {"error":"oops"}\n\n'.repeat(500));
    assert.equal(found.length, 32);
    scanner.finish();
    assert.equal(scanner.bufferedChars, 0);
});

test('imported routes and per-route label histories are capped without losing aggregate totals', () => {
    const store = errors.createErrorStore();
    const route = { source: 'custom', host: 'p.test', model: 'm', provider: '' };
    for (let i = 0; i < 200; i++) errors.recordRouteOutcome(store, route, { code: 'code-' + i, kind: 'response', message: 'failed' });
    const stats = Object.values(store.routes)[0];
    assert.equal(stats.errors, 200);
    assert.ok(Object.keys(stats.byLabel).length <= errors.ERROR_LABEL_LIMIT);
    assert.equal(Object.values(stats.byLabel).reduce((sum, count) => sum + count, 0), 200);
    for (let i = 0; i < 1000; i++) store.routes['custom|p.test|m-' + i + '|'] = { ...route, model: 'm-' + i, ok: 1, errors: 0, lastSeenAt: i };
    errors.normalizeErrorStore(store);
    assert.equal(Object.keys(store.routes).length, errors.ERROR_ROUTE_LIMIT);
    assert.ok(store.log.length <= errors.ERROR_LOG_LIMIT);
});
