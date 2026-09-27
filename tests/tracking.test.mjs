// Replays SillyTavern generation lifecycles against the real handlers in index.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as metrics from '../metrics.js';
import * as errors from '../errors.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extract(name) {
    const match = source.match(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(match, name);
    return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

const FUNCTIONS = [
    'getEasternParts', 'getDayKey', 'getHourKey', 'getWeekKey', 'getMonthKey',
    'addToUsageBuckets', 'recordUsage', 'recordFailedAttempt',
    'handleGenerationStarted', 'handleGenerateAfterData', 'handleMessageReceived', 'handleImpersonateReady',
    'handleGenerationStopped', 'handleGenerationEnded', 'handleAttemptResolved', 'recordAttempt',
    'countMessageOutput', 'extractResponseText', 'flushPendingQuietGeneration',
    'installGenerationRequestObserver', 'observeGenerationRequest', 'parseRequestBody', 'isAbortedRequest',
    'observeGenerationResponse', 'inspectResponse', 'recordHttpError', 'watchStreamedResponse', 'recordRouteResult',
];

const emptyUsage = () => ({
    session: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {} },
    allTime: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 },
    byDay: {}, byHour: {}, byWeek: {}, byMonth: {}, byChat: {}, byModel: {}, bySource: {},
});

function runtime() {
    const settings = { usage: emptyUsage(), errorTracking: errors.createErrorStore() };
    const timers = [];
    let clock = Date.parse('2026-09-24T21:00:00Z');
    const responses = [];
    const chat = [];

    const context = vm.createContext({
        ...metrics,
        ...errors,
        URL,
        TextDecoder,
        console: { log() {}, error: (...args) => { throw new Error(args.join(' ')); }, warn() {} },
        EASTERN_TIMEZONE: 'America/New_York',
        settings,
        getSettings: () => settings,
        saveSettings() {},
        getUsageStats: () => ({}),
        eventSource: { emit() {} },
        getCurrentEasternTime: () => new Date(clock),
        getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }),
        main_api: 'openai',
        lastRecordedTimestamp: null,
        maybeAutoFetchOpenRouterPricing() {},
        recordHealthError() {},
        scheduleErrorPanelRender() {},
        countTokens: async (text) => String(text).split(/\s+/).filter(Boolean).length,
        countInputTokens: async () => 100,
        getCurrentModelId: () => 'model-a',
        getCurrentSourceId: () => 'openrouter',
        getCurrentChatId: () => 'chat-1',
        getContext: () => ({ chat }),
        streamingProcessor: null,
        stScript: { extractMessageFromData: (data) => data?.choices?.[0]?.message?.content ?? '' },
        extractResponseReasoning: async (data) => data?.choices?.[0]?.message?.reasoning ?? '',
        window: {
            location: { origin: 'http://localhost:8000' },
            fetch: async () => {
                const next = responses.shift();
                if (next instanceof Error) throw next;
                if (next?.rejectWith !== undefined) throw next.rejectWith;
                return next;
            },
        },
    });
    for (const name of FUNCTIONS) vm.runInContext(extract(name), context);
    vm.runInContext(`
        let pendingGenerationStart = null;
        const GENERATION_REQUEST_PATHS = new Set(['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate']);
        const TOKEN_USAGE_FETCH_PATCHED = Symbol.for('tokenUsageTrackerFetchPatched');
    `, context);
    context.attemptTracker = metrics.createAttemptTracker({
        onResolve: (...args) => context.handleAttemptResolved(...args),
        now: () => clock,
        setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }),
    });
    context.installGenerationRequestObserver();

    const settle = async () => {
        for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    };

    return {
        context,
        settings,
        chat,
        settle,
        async advance(ms) {
            clock += ms;
            for (const timer of timers.filter(t => t.at <= clock)) {
                timers.splice(timers.indexOf(timer), 1);
                timer.fn();
            }
            await settle();
        },
        respond(response) {
            responses.push(response);
        },
        send({ stream = false, body = {}, signal } = {}) {
            return context.window.fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                body: JSON.stringify({ messages: [], stream, ...body }),
                signal,
            });
        },
        route(key) {
            return settings.errorTracking.routes[key];
        },
        today() {
            return settings.usage.byDay[context.getDayKey(new Date(clock))];
        },
    };
}

const ok = (json = {}) => {
    const body = JSON.stringify(json);
    const response = { ok: true, status: 200, json: async () => JSON.parse(body), clone: () => ok(json) };
    return response;
};
const httpError = (status) => ({ ok: false, status, json: async () => ({ error: true }), text: async () => '{"error":true}', clone() { return this; } });
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function counts(bucket) {
    return { messageCount: bucket?.messageCount || 0, stopped: bucket?.stopped || 0, failed: bucket?.failed || 0 };
}

test('non-streaming success records one generation with nested model and source counts', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok({ choices: [{ message: { content: 'x' } }] }));
    await r.send();
    r.chat.push({ mes: 'one two three' });
    r.context.handleMessageReceived(0, 'normal');
    r.context.handleGenerationEnded();
    await r.advance(5000);

    const day = r.today();
    assert.deepEqual(counts(day), { messageCount: 1, stopped: 0, failed: 0 });
    assert.equal(day.input, 100);
    assert.equal(day.output, 3);
    assert.equal(day.models['model-a'].messageCount, 1);
    assert.equal(day.sources.openrouter.messageCount, 1);
    assert.equal(day.sources.openrouter.models['model-a'].messageCount, 1);
    assert.equal(r.settings.usage.byChat['chat-1'].messageCount, 1);
    const hour = r.settings.usage.byHour[r.context.getHourKey(new Date(Date.parse('2026-09-24T21:00:00Z')))];
    assert.equal(hour.sources.openrouter.messageCount, 1);
});

test('HTTP error is a failed attempt with no tokens or generation', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(httpError(429));
    await r.send();
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(5000);

    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
    assert.equal(r.today().total, 0);
    assert.equal(r.today().sources.openrouter.failed, 1);
    assert.equal(r.settings.usage.byModel['model-a'].failed, 1);
});

test('network error is failed; an unmatched URL is ignored and returned untouched', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const other = ok();
    r.respond(other);
    assert.equal(await r.context.window.fetch('/api/backends/chat-completions/status', {}), other);
    r.respond(new TypeError('Failed to fetch'));
    await assert.rejects(r.send());
    await r.settle();
    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
});

test('streaming success: end event before the message is not counted as failed', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('swipe', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const sp = { result: '', isStopped: false, isFinished: false };
    r.context.streamingProcessor = sp;
    r.respond(ok());
    await r.send({ stream: true });
    sp.result = 'streamed reply here';
    sp.isFinished = true;
    r.context.handleGenerationEnded();
    await r.advance(5000);
    assert.equal(r.today(), undefined);

    r.chat.push({ mes: 'streamed reply here' });
    r.context.handleMessageReceived(0, 'swipe');
    await r.settle();
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 0 });
});

test('streaming error mid-stream is failed at the end event', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const sp = { result: 'partial', isStopped: false, isFinished: false };
    r.context.streamingProcessor = sp;
    r.respond(ok());
    await r.send({ stream: true });
    sp.isStopped = true; // onErrorStreaming
    r.context.handleGenerationEnded();
    // onErrorStreaming still emits MESSAGE_RECEIVED for normal generations
    r.chat.push({ mes: 'partial' });
    r.context.handleMessageReceived(0, 'normal');
    await r.advance(5000);
    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
});

test('user stop while streaming records partial output as a stopped generation', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const sp = { result: '', isStopped: false, isFinished: false, reasoningHandler: { reasoning: 'think' } };
    r.context.streamingProcessor = sp;
    r.respond(ok());
    await r.send({ stream: true });
    sp.result = 'a partial answer';
    sp.isFinished = true; // onStopStreaming
    r.context.handleGenerationEnded();
    r.context.handleGenerationStopped();
    await r.advance(5000);
    // onFinishStreaming then emits MESSAGE_RECEIVED for the stopped message
    r.chat.push({ mes: 'a partial answer' });
    r.context.handleMessageReceived(0, 'normal');
    await r.settle();

    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
    assert.equal(r.today().output, 3);
    assert.equal(r.today().reasoning, 1);
});

test('user stop of a non-streaming request is stopped once, not failed', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(abortError());
    const request = r.send();
    r.context.handleGenerationEnded();
    r.context.handleGenerationStopped();
    await assert.rejects(request);
    await r.advance(5000);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
    assert.equal(r.today().output, 0);
});

test('an aborted request is stopped even when it settles before the stop event', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(abortError());
    await assert.rejects(r.send());
    await r.settle();
    r.context.handleGenerationEnded();
    r.context.handleGenerationStopped();
    await r.advance(5000);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
});

test('an aborted quiet generation is stopped, not failed', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(abortError());
    await assert.rejects(r.send());
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(20_000);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
});

test('quiet generation is recorded when its response arrives, with output and no chat', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok({ choices: [{ message: { content: 'a short summary', reasoning: 'hmm ok' } }] }));
    const response = await r.send();
    assert.deepEqual(await response.json(), { choices: [{ message: { content: 'a short summary', reasoning: 'hmm ok' } }] });
    await r.settle();

    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 0 });
    assert.equal(r.today().output, 3);
    assert.equal(r.today().reasoning, 2);
    assert.deepEqual(r.settings.usage.byChat, {});
    assert.equal(await r.context.flushPendingQuietGeneration('late text'), false);
    assert.equal(r.today().messageCount, 1);
});

test('quiet error response is failed and never counted as a generation', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok({ error: { message: 'Rate limited' } }));
    await r.send();
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(5000);
    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
});

test('flushing a quiet generation before its response wins without double counting', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    assert.equal(await r.context.flushPendingQuietGeneration('caller provided text here'), true);
    r.respond(ok({ choices: [{ message: { content: 'x' } }] }));
    await r.send();
    await r.settle();
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 0 });
    assert.equal(r.today().output, 4);
});

test('a quiet generation overlapping a main one resolves independently', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok());
    await r.send();
    r.respond(httpError(500));
    await r.send();
    await r.settle();
    r.chat.push({ mes: 'main reply' });
    r.context.handleMessageReceived(0, 'normal');
    r.context.handleGenerationEnded();
    await r.advance(5000);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 1 });
    assert.equal(r.settings.usage.byChat['chat-1'].messageCount, 1);
    assert.equal(r.settings.usage.byChat['chat-1'].failed || 0, 0);
});

test('continue counts only the new tokens, including non-streaming appendFinal', async () => {
    const r = runtime();
    r.chat.push({ mes: 'existing four word message', extra: { token_count: 4 } });
    r.context.handleGenerationStarted('continue', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok());
    await r.send();
    r.chat[0] = { mes: 'existing four word message plus two', extra: { token_count: 6 } };
    r.context.handleMessageReceived(0, 'appendFinal');
    await r.settle();
    assert.equal(r.today().output, 2);
});

test('impersonation succeeds via IMPERSONATE_READY and ignores other received messages', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('impersonate', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok());
    await r.send();
    r.chat.push({ mes: 'unrelated' });
    r.context.handleMessageReceived(0, 'extension');
    r.context.handleImpersonateReady('user says hello');
    await r.settle();
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 0 });
    assert.equal(r.today().output, 3);
});

test('dry runs and non-API messages are ignored; external recordUsage callers still work', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, true);
    r.context.handleGenerateAfterData({ prompt: [] }, true);
    r.chat.push({ mes: 'hello' });
    r.context.handleMessageReceived(0, 'first_message');
    r.context.handleMessageReceived(0, 'normal');
    await r.settle();
    assert.equal(r.today(), undefined);

    r.context.recordUsage(10, 5, null, 'model-b', 'custom', 0);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 0, failed: 0 });
    assert.equal(r.today().models['model-b'].messageCount, 1);
});

// Route error tracking: responses are real Response objects so clones and streams behave as in the browser
const encoder = new TextEncoder();
const CUSTOM = { chat_completion_source: 'custom', model: 'glm-4.6', custom_url: 'https://api.example.com/v1' };
const CUSTOM_KEY = 'custom|api.example.com|glm-4.6|';

/** A streamed response whose body the test writes */
function streamed() {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    return {
        response: new Response(body, { status: 200 }),
        write: (text) => controller.enqueue(encoder.encode(text)),
        end: () => controller.close(),
        fail: (error) => controller.error(error),
    };
}

function startStreaming(r, type = 'normal') {
    r.context.handleGenerationStarted(type, {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const sp = { result: '', isStopped: false, isFinished: false };
    r.context.streamingProcessor = sp;
    return sp;
}

test('requests are tracked by the route in their body, even without a generation event', async () => {
    const r = runtime();
    r.respond(ok({ choices: [{ message: { content: 'x' } }] }));
    await r.send({ body: CUSTOM });
    r.respond(new Response('{"error":{"message":"Rate limited","code":429}}', { status: 429, statusText: 'Too Many Requests' }));
    await r.send({ body: CUSTOM });
    r.respond(new Response('<html><title>502 Bad Gateway</title></html>', { status: 502, statusText: 'Bad Gateway' }));
    await r.send({ body: CUSTOM });
    await r.settle();

    const route = r.route(CUSTOM_KEY);
    assert.equal(route.ok, 1);
    assert.equal(route.errors, 2);
    assert.equal(route.byLabel['429'], 1);
    assert.equal(route.byLabel['502'], 1);
    assert.equal(r.settings.errorTracking.log[0].message, 'Rate limited');
    assert.equal(route.lastError.message, '502 Bad Gateway');
    assert.equal(r.today(), undefined, 'no usage without a generation');
});

test('an error payload sent with HTTP 200 fails a main generation instead of succeeding at the next one', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    r.respond(ok({ error: { message: 'Too Many Requests' }, quota_error: false }));
    await r.send({ body: CUSTOM });
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(5000);
    r.context.handleGenerationStarted('normal', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    await r.settle();

    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
    assert.equal(r.route(CUSTOM_KEY).lastError.kind, 'response');
    assert.equal(r.route(CUSTOM_KEY).lastError.message, 'Too Many Requests');
    // The upstream status is recovered from its reason phrase
    assert.equal(r.route(CUSTOM_KEY).byLabel['429'], 1);
});

test('an error event mid-stream fails the generation and names the provider that failed', async () => {
    const r = runtime();
    const sp = startStreaming(r);
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: { chat_completion_source: 'openrouter', model: 'deepseek/deepseek-chat', provider: ['Together', 'DeepInfra'] } });
    s.write('data: {"choices":[{"delta":{"content":"Hel"}}],"provider":"Together"}\n\n');
    s.write('data: {"error":{"code":502,"message":"Provider returned error","metadata":{"provider_name":"Together","raw":"upstream timeout"}}}\n\n');
    await r.settle();
    // SillyTavern only shows a toast, then finishes the stream as if it succeeded
    s.write('data: [DONE]\n\n');
    s.end();
    sp.result = 'Hel';
    sp.isFinished = true;
    r.context.handleGenerationEnded();
    r.chat.push({ mes: 'Hel' });
    r.context.handleMessageReceived(0, 'normal');
    await r.advance(5000);

    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
    const route = r.route('openrouter||deepseek/deepseek-chat|Together');
    assert.equal(route.errors, 1);
    assert.equal(route.byLabel['502'], 1);
    assert.equal(route.lastError.message, 'Provider returned error: upstream timeout');
    assert.equal(r.settings.errorTracking.log[0].genType, 'normal');
});

test('a streamed success counts for the provider the stream names', async () => {
    const r = runtime();
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: { chat_completion_source: 'openrouter', model: 'm', provider: [] } });
    s.write('data: {"choices":[{"delta":{"content":"Hi"}}],"provider":"DeepInfra"}\n\ndata: [DONE]\n\n');
    s.end();
    await r.settle();
    assert.equal(r.route('openrouter||m|DeepInfra').ok, 1);
    assert.equal(r.settings.errorTracking.log.length, 0);
});

test('a plain JSON error answering a streaming request is a stream error', async () => {
    const r = runtime();
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: CUSTOM });
    s.write('{"error":{"message":"Invalid model"}}');
    s.end();
    await r.settle();
    assert.equal(r.route(CUSTOM_KEY).lastError.kind, 'stream');
    assert.equal(r.route(CUSTOM_KEY).lastError.message, 'Invalid model');
});

test('a dropped connection mid-stream is recorded as interrupted', async () => {
    const r = runtime();
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: CUSTOM });
    s.write('data: {"choices":[]}\n\n');
    s.fail(new TypeError('network error'));
    await r.settle();
    assert.equal(r.route(CUSTOM_KEY).lastError.kind, 'interrupted');
    assert.equal(r.route(CUSTOM_KEY).lastError.message, 'network error');
});

test('a stream SillyTavern failed to read is a stream error even when its abort arrives first', async () => {
    const r = runtime();
    const sp = startStreaming(r);
    const controller = new AbortController();
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: CUSTOM, signal: controller.signal });
    // onErrorStreaming: abort, then isStopped
    controller.abort();
    sp.isStopped = true;
    s.fail(controller.signal.reason);
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(5000);

    assert.equal(r.route(CUSTOM_KEY).lastError.kind, 'stream');
    assert.deepEqual(counts(r.today()), { messageCount: 0, stopped: 0, failed: 1 });
});

test('a user stop of a stream is not an API error', async () => {
    const r = runtime();
    const sp = startStreaming(r);
    const controller = new AbortController();
    const s = streamed();
    r.respond(s.response);
    await r.send({ stream: true, body: CUSTOM, signal: controller.signal });
    s.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    await r.settle();
    // onStopStreaming, then stopGeneration's own abort with a reason
    sp.result = 'partial';
    sp.isFinished = true;
    controller.abort('Clicked stop button');
    s.fail(controller.signal.reason);
    r.context.handleGenerationEnded();
    r.context.handleGenerationStopped();
    await r.advance(5000);

    assert.equal(r.route(CUSTOM_KEY), undefined);
    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
});

test('an abort that rejects with its reason is a stop, not a network error', async () => {
    const r = runtime();
    r.context.handleGenerationStarted('quiet', {}, false);
    r.context.handleGenerateAfterData({ prompt: [] }, false);
    const controller = new AbortController();
    const reason = new Error('Cancelled by stop event');
    r.respond({ rejectWith: reason });
    const request = r.send({ body: CUSTOM, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(request);
    await r.settle();
    r.context.handleGenerationEnded();
    await r.advance(20_000);

    assert.deepEqual(counts(r.today()), { messageCount: 1, stopped: 1, failed: 0 });
    assert.equal(r.route(CUSTOM_KEY), undefined);
});

test('a network error is recorded against the route', async () => {
    const r = runtime();
    r.respond(new TypeError('Failed to fetch'));
    await assert.rejects(r.send({ body: CUSTOM }));
    await r.settle();
    assert.equal(r.route(CUSTOM_KEY).byLabel.network, 1);
    assert.equal(r.route(CUSTOM_KEY).lastError.message, 'Failed to fetch');
});
