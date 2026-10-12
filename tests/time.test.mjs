import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createUsageClock } from '../time.js';

const BASE = Date.parse('2026-10-12T03:59:59.800Z'); // Just before midnight in Eastern time.
const INTERVAL = 300000;
const logger = { log() {}, warn() {} };
const response = data => ({ ok: true, json: async () => data });

function fixture(fetchFn, options = {}) {
    let wall = BASE;
    let elapsed = 0;
    const clock = createUsageClock({ fetchFn, wallNow: () => wall, elapsedNow: () => elapsed, logger, ...options });
    return { clock, advance(ms) { wall += ms; elapsed += ms; } };
}

test('startup shares one request and establishes corrected time before the first usage timestamp', async () => {
    let release;
    let requests = 0;
    const r = fixture(() => { requests++; return new Promise(resolve => { release = resolve; }); });
    const initial = r.clock.sync();
    assert.equal(r.clock.sync(), initial);
    for (let i = 0; i < 100; i++) r.clock.now();
    await Promise.resolve();
    assert.equal(requests, 1);
    release(response({ datetime: '2026-10-12T00:00:01.800-04:00', unixtime: BASE / 1000 }));
    assert.equal(await initial, true);
    const firstUsageTime = r.clock.now();
    assert.equal(firstUsageTime.toISOString(), '2026-10-12T04:00:01.800Z');
    const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(firstUsageTime);
    assert.equal(easternDay, '2026-10-12');
    assert.equal(requests, 1);
});

test('request latency uses the midpoint and datetime retains sub-second precision', async () => {
    let r;
    r = fixture(async () => {
        r.advance(200);
        return response({ datetime: new Date(BASE + 1100).toISOString(), unixtime: Math.floor(BASE / 1000) });
    });
    await r.clock.sync();
    assert.equal(r.clock.now().getTime(), BASE + 1200);
});

test('failed startup falls back locally and repeated reads throttle retries for five minutes', async () => {
    let requests = 0;
    const r = fixture(async () => { requests++; throw new Error('offline'); });
    assert.equal(await r.clock.sync(), false);
    for (let i = 0; i < 100; i++) assert.equal(r.clock.now().getTime(), BASE);
    r.advance(INTERVAL - 1);
    await r.clock.sync();
    assert.equal(requests, 1);
    r.advance(1);
    assert.equal(await r.clock.sync(), false);
    assert.equal(requests, 2);
});

test('periodic reads share one refresh and keep the previous offset if it fails', async () => {
    let requests = 0;
    let reject;
    const r = fixture(async () => {
        if (++requests === 1) return response({ unixtime: (BASE + 5000) / 1000 });
        return new Promise((_resolve, rejectRequest) => { reject = rejectRequest; });
    });
    await r.clock.sync();
    r.advance(INTERVAL);
    for (let i = 0; i < 100; i++) assert.equal(r.clock.now().getTime(), BASE + INTERVAL + 5000);
    const refresh = r.clock.sync();
    await Promise.resolve();
    assert.equal(requests, 2);
    reject(new Error('offline'));
    assert.equal(await refresh, false);
    assert.equal(r.clock.now().getTime(), BASE + INTERVAL + 5000);
});

test('invalid responses and HTTP failures do not change the clock', async () => {
    for (const result of [response({ datetime: 'bad' }), response({ unixtime: Infinity }), { ok: false, status: 503 }]) {
        const r = fixture(async () => result);
        assert.equal(await r.clock.sync(), false);
        assert.equal(r.clock.now().getTime(), BASE);
    }
});

test('unix seconds remain a fallback when a precise datetime is absent or invalid', async () => {
    const r = fixture(async () => response({ datetime: 'bad', unixtime: (BASE + 3000) / 1000 }));
    assert.equal(await r.clock.sync(), true);
    assert.equal(r.clock.now().getTime(), BASE + 3000);
});

test('a synchronous fetch failure releases the shared request and permits a later retry', async () => {
    let requests = 0;
    const r = fixture(() => { requests++; throw new Error('fetch unavailable'); });
    assert.equal(await r.clock.sync(), false);
    r.advance(INTERVAL);
    assert.equal(await r.clock.sync(), false);
    assert.equal(requests, 2);
});

test('wall clock adjustments do not cause early retries or suppress scheduled refreshes', async () => {
    let wall = BASE;
    let elapsed = 0;
    let requests = 0;
    const clock = createUsageClock({ wallNow: () => wall, elapsedNow: () => elapsed, logger,
        fetchFn: async () => { requests++; return response({ unixtime: wall / 1000 }); } });
    await clock.sync();
    wall += 86400000;
    await clock.sync();
    assert.equal(requests, 1);
    wall -= 2 * 86400000;
    elapsed += INTERVAL;
    await clock.sync();
    assert.equal(requests, 2);
});

test('the real extension initializer waits before settings timestamps and event registration', async () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    let release;
    let initialized;
    let sessionTime = null;
    let listeners = 0;
    const r = fixture(() => new Promise(resolve => { release = resolve; }));
    const noop = () => {};
    const context = {
        console: logger, usageClock: r.clock, jQuery: callback => { initialized = callback(); },
        loadSettings: () => { sessionTime = r.clock.now(); }, saveSettings: noop,
        registerSlashCommands: noop, createSettingsUI: noop, maybeAutoFetchOpenRouterPricing: noop,
        patchBackgroundGenerations: noop, eventSource: { on: () => { listeners++; }, emit: noop },
        event_types: {}, main_api: 'openai', getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }),
        setTimeout: noop,
    };
    for (const handler of ['handleGenerationStarted', 'handleGenerationAfterCommands', 'handleGenerateAfterData',
        'handleMessageReceived', 'handleGenerationStopped', 'handleChatChanged', 'handleImpersonateReady',
        'handleGenerationEnded']) context[handler] = noop;
    vm.runInNewContext(source.slice(source.indexOf('jQuery(async () => {')), context);
    await Promise.resolve();
    assert.equal(sessionTime, null);
    assert.equal(listeners, 0);
    release(response({ datetime: '2026-10-12T04:00:01.800Z' }));
    await initialized;
    assert.equal(sessionTime.toISOString(), '2026-10-12T04:00:01.800Z');
    assert.ok(listeners > 0);
});

test('a stalled request reaches its deadline and falls back without blocking initialization indefinitely', async () => {
    const r = fixture((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { timeoutMs: 10 });
    // AbortSignal.timeout does not itself keep Node's event loop alive.
    const keepAlive = setTimeout(() => {}, 100);
    try {
        assert.equal(await r.clock.sync(), false);
        assert.equal(r.clock.now().getTime(), BASE);
    } finally {
        clearTimeout(keepAlive);
    }
});
