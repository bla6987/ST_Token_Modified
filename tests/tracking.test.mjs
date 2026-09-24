// Replays SillyTavern generation lifecycles against the real handlers in index.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as metrics from '../metrics.js';

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
    'installGenerationRequestObserver', 'bindGenerationRequest', 'isStreamingRequestBody',
    'observeGenerationResponse', 'resolveQuietResponse',
];

const emptyUsage = () => ({
    session: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {} },
    allTime: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 },
    byDay: {}, byHour: {}, byWeek: {}, byMonth: {}, byChat: {}, byModel: {}, bySource: {},
});

function runtime() {
    const settings = { usage: emptyUsage() };
    const timers = [];
    let clock = Date.parse('2026-09-24T21:00:00Z');
    const responses = [];
    const chat = [];

    const context = vm.createContext({
        ...metrics,
        URL,
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
        send({ stream = false } = {}) {
            return context.window.fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                body: JSON.stringify({ messages: [], stream }),
            });
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
const httpError = (status) => ({ ok: false, status, json: async () => ({ error: true }), clone() { return this; } });
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
