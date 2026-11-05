// Counts the repeated work the tracker must not do: formatter construction, tokenizer calls,
// full renders and history scans. Totals must stay what a brute-force calculation gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { collectPromptTexts, createTokenCounter } from '../token-count.js';
import { bumpCounts } from '../metrics.js';
import * as pricing from '../pricing.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extract(name) {
    const match = source.match(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(match, name);
    return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

const declaration = name => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0] ?? '';

/** Intl for a vm context that counts what bucket-key calculation asks of it. */
function countingIntl(counts) {
    return {
        DateTimeFormat: class extends Intl.DateTimeFormat {
            constructor(...args) { super(...args); counts.formatters++; }
            formatToParts(date) { counts.formatToParts++; return super.formatToParts(date); }
        },
    };
}

function tokenizerStub({ signature = () => 'tokenizer-a' } = {}) {
    const calls = [];
    const counter = createTokenCounter({
        tokenize: async text => { calls.push(text); return text.length; },
        estimate: () => -1,
        getSignature: signature,
        onError() {},
    });
    return { calls, counter };
}

test('bucket keys reuse one date formatter and still give Eastern calendar parts', () => {
    const counts = { formatters: 0, formatToParts: 0 };
    const context = vm.createContext({ usageRevision: 0, EASTERN_TIMEZONE: 'America/New_York', Intl: countingIntl(counts), Date });
    vm.runInContext(`${declaration('_fmtEasternParts')}\n${extract('getEasternParts')}`, context);
    const expected = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    for (let i = 0; i < 1000; i++) {
        const date = new Date(Date.UTC(2026, 0, 1) + i * 7 * 3600000);
        const parts = Object.fromEntries(expected.formatToParts(date).map(p => [p.type, Number(p.value)]));
        const actual = context.getEasternParts(date);
        assert.deepEqual([actual.year, actual.month, actual.day, actual.hour], [parts.year, parts.month, parts.day, parts.hour]);
    }
    assert.ok(counts.formatters <= 1, `${counts.formatters} formatters for 1000 calls`);
});

test('prompt framing keeps every field, image, role and boundary cost', async () => {
    const prompt = [
        { role: 'system', content: 'aaaa' },
        { role: 'user', name: 'bb', content: [{ type: 'text', text: 'cc' }, { type: 'image_url', image_url: {} }, { type: 'image' }, { type: 'text', text: '' }] },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'dd', arguments: 'eee' } }, { id: 'no-function' }] },
        { role: 'assistant', invocations: [{ function: { name: 'f', arguments: 'gg' } }], function_call: { name: 'hhh', arguments: { notText: true } } },
        { content: 42, name: 7 },
    ];
    const { texts, fixedTokens } = collectPromptTexts(prompt);
    assert.deepEqual(texts, ['aaaa', 'cc', 'bb', 'dd', 'eee', 'f', 'gg', 'hhh']);
    // 4 roles + 2 images + 3 per message
    assert.equal(fixedTokens, 4 + 2 * 765 + 5 * 3);
    assert.deepEqual(collectPromptTexts('whole prompt'), { texts: ['whole prompt'], fixedTokens: 0 });
    for (const empty of ['', undefined, null, {}]) assert.deepEqual(collectPromptTexts(empty), { texts: [], fixedTokens: 0 });
});

test('unchanged prompt context is not sent to the tokenizer again', async () => {
    const { calls, counter } = tokenizerStub();
    const history = Array.from({ length: 200 }, (_, i) => `message number ${i}`);
    const first = await counter.countAll(history);
    assert.equal(first, history.reduce((sum, text) => sum + text.length, 0));
    assert.equal(calls.length, 200);

    calls.length = 0;
    const second = await counter.countAll([...history, 'one new message']);
    assert.equal(second, first + 'one new message'.length);
    assert.deepEqual(calls, ['one new message']);
});

test('a text repeated within one prompt is tokenized once and counted each time', async () => {
    const { calls, counter } = tokenizerStub();
    assert.equal(await counter.countAll(['abc', 'de', 'abc', 'abc']), 11);
    assert.equal(calls.filter(text => text === 'abc').length, 1);
});

test('tokenizer calls run in bounded parallel', async () => {
    let active = 0;
    let peak = 0;
    const counter = createTokenCounter({
        tokenize: async text => {
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return text.length;
        },
        estimate: () => -1, getSignature: () => 'a', onError() {},
    });
    const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
    assert.equal(await counter.countAll(texts), texts.join('').length);
    assert.equal(peak, 4);
});

test('a tokenizer or model change never reuses earlier counts', async () => {
    let signature = 'tokenizer-a';
    const { calls, counter } = tokenizerStub({ signature: () => signature });
    await counter.count('same text');
    await counter.count('same text');
    assert.equal(calls.length, 1);
    signature = 'tokenizer-b';
    await counter.count('same text');
    assert.equal(calls.length, 2);
});

test('a count finished after the model changed is returned but not cached', async () => {
    let signature = 'a';
    let release;
    const calls = [];
    const counter = createTokenCounter({
        tokenize: text => { calls.push(text); return new Promise(resolve => { release = resolve; }); },
        estimate: () => -1, getSignature: () => signature, onError() {},
    });
    const pending = counter.count('text');
    await new Promise(resolve => setImmediate(resolve));
    signature = 'b';
    release(5);
    assert.equal(await pending, 5);
    assert.equal(counter.size, 0);
});

test('tokenizer failures use the estimate without caching it', async () => {
    let fail = true;
    const errors = [];
    const counter = createTokenCounter({
        tokenize: async text => { if (fail) throw new Error('offline'); return text.length; },
        estimate: () => 99, getSignature: () => 'a', onError: error => errors.push(error.message),
    });
    assert.equal(await counter.count('abc'), 99);
    assert.equal(await counter.countAll(['abc']), 99);
    assert.deepEqual(errors, ['offline', 'offline']);
    fail = false;
    assert.equal(await counter.count('abc'), 3);
});

test('a tokenizer promise that never settles does not block later counts of the same text', async () => {
    let hang = true;
    const counter = createTokenCounter({
        tokenize: async text => { if (hang) await new Promise(() => {}); return text.length; },
        estimate: () => -1, getSignature: () => 'a', onError() {},
    });
    counter.count('system prompt');
    await new Promise(resolve => setImmediate(resolve));
    hang = false;
    assert.equal(await counter.count('system prompt'), 13);
});

test('cached text stays within its entry and character limits, oldest first', async () => {
    const calls = [];
    const counter = createTokenCounter(
        { tokenize: async text => { calls.push(text); return text.length; }, estimate: () => -1, getSignature: () => 'a', onError() {} },
        { maxEntries: 3, maxChars: 10, maxTextChars: 8 },
    );
    await counter.countAll(['aaa', 'bbb', 'ccc']);
    assert.equal(counter.size, 3);
    // A hit keeps 'aaa' recent, so 'bbb' is the one evicted
    await counter.count('aaa');
    await counter.count('ddd');
    assert.equal(counter.size, 3);
    assert.equal(counter.chars, 9);
    calls.length = 0;
    await counter.count('aaa');
    await counter.count('bbb');
    assert.deepEqual(calls, ['bbb']);

    await counter.count('toolongtocache');
    assert.ok(counter.chars <= 10 && counter.size <= 3);
    calls.length = 0;
    await counter.count('toolongtocache');
    assert.deepEqual(calls, ['toolongtocache']);
});

test('input counting reads the prompt after later event listeners have edited it', async () => {
    const context = vm.createContext({ usageRevision: 0, setTimeout, collectPromptTexts,
        tokenCounter: { countAll: async texts => texts.join('').length } });
    vm.runInContext(extract('countInputTokens'), context);
    const data = { prompt: [{ role: 'user', content: 'aa' }] };
    const pending = context.countInputTokens(data);
    data.prompt[0].content = 'edited by a later listener';
    assert.equal(await pending, 'edited by a later listener'.length + 1 + 3);
});

test('a background request returns without waiting for its tokens to be counted', async () => {
    const recorded = [];
    let releaseCount;
    const service = { sendRequest: async () => ({ content: 'reply text' }) };
    const context = vm.createContext({ usageRevision: 0,
        TOKEN_USAGE_PATCHED: Symbol('patched'),
        console: { log() {}, error(...args) { throw new Error(args.join(' ')); } },
        getContext: () => ({ ConnectionManagerRequestService: service }),
        getCurrentModelId: () => 'model', getCurrentSourceId: () => 'source',
        countInputTokens: () => new Promise(resolve => { releaseCount = resolve; }),
        countTokens: async text => (typeof text === 'string' ? text.split(' ').length : 0),
        recordUsage: (...args) => recorded.push(args.slice(0, 2)),
    });
    vm.runInContext(extract('tryPatchSendRequest'), context);
    assert.equal(context.tryPatchSendRequest(), true);
    const result = await Promise.race([service.sendRequest('p', []), new Promise(resolve => setTimeout(resolve, 50, 'blocked'))]);
    assert.equal(result.content, 'reply text');
    assert.equal(recorded.length, 0);
    releaseCount(7);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(recorded, [[7, 2]]);
});

/** The real UI update path over a synthetic history; only rendering and DOM are stubbed. */
function uiRuntime({ now = '2026-11-05T17:00:00Z', days = 1500, visible = true } = {}) {
    const counts = { formatters: 0, formatToParts: 0, chart: 0, summary: 0, chartData: 0, stats: 0, miniview: 0 };
    const usage = { byDay: {}, byHour: {}, byWeek: {}, byMonth: {}, byChat: {}, byModel: {}, bySource: {}, session: {}, allTime: {} };
    const start = Date.parse(now);
    for (let i = 0; i < days; i++) {
        const key = new Date(start - i * 86400000).toISOString().slice(0, 10);
        usage.byDay[key] = { total: 3e6, models: { paid: { input: 1e6, output: 2e6, total: 3e6 }, legacy: 40 } };
    }
    const settings = { usage };
    const prices = { paid: { in: 1, out: 2 } };
    const texts = {};
    let clock = start;
    const context = vm.createContext({ usageRevision: 0,
        ...pricing, bumpCounts,
        Intl: countingIntl(counts),
        EASTERN_TIMEZONE: 'America/New_York',
        extensionName: 'token-usage-tracker',
        console: { log() {} },
        saveSettings() {}, eventSource: { emit() {} }, normalizeErrorStore: value => value, renderErrorPanel() {},
        modelPriceCache: new Map(), modelConfigPriceDrafts: new Map(),
        document: { querySelector: () => ({ offsetParent: visible ? {} : null }) },
        $: selector => ({ text(value) { texts[selector] = value; } }),
        getSettings: () => settings,
        getUsageStats: () => { counts.stats++; return { today: { total: 0 }, thisWeek: { total: 0 }, thisMonth: { total: 0 }, allTime: { total: 0 }, session: {}, byModel: {} }; },
        getCurrentEasternTime: () => new Date(clock),
        getModelPrice: model => prices[model] ?? { in: 0, out: 0 },
        formatTokens: String,
        modelConfigState: {},
        calculateAllTimeCost: () => 0,
        calculateEfficiencyMetrics: () => ({ ratio: 0, perMessage: 0 }),
        getChartDataForGranularity: () => { counts.chartData++; return []; },
        renderChartByType: () => { counts.chart++; },
        updateRangeSummary: () => { counts.summary++; },
        updateSourceDropdown() {}, isModelConfigVisible: () => false, scheduleModelConfigRender() {},
        updateChatUsageDisplay() {}, updateHealthIndicator() {},
        updateMiniviewStats: () => { counts.miniview++; },
        chartData: [], currentSourceFilter: 'all', currentPeriodDays: null,
    });
    vm.runInContext(declaration('_fmtEasternParts'), context);
    for (const name of ['getEasternParts', 'getDayKey', 'getHourKey', 'getWeekKey', 'getMonthKey', 'calculateCost', 'updateUIStats', 'updateSourceFilter',
        'addToUsageBuckets', 'importUsageData', 'invalidateModelPriceCache', 'sanitizeUsageBucket', 'sanitizeUsageBuckets', 'isModelColor',
        'isUsagePanelVisible', 'getCurrentPeriodDays', 'calculateDaysCost']) {
        // Helpers absent from older revisions are skipped so the counts below still measure them
        if (source.match(new RegExp(`^function ${name}\\(`, 'm'))) vm.runInContext(extract(name), context);
    }
    /** What scanning all of history would give, using the same key functions. */
    const bruteForce = () => {
        const week = context.getWeekKey(new Date(clock));
        const month = context.getMonthKey(new Date(clock));
        const costs = { week: 0, month: 0 };
        for (const [key, day] of Object.entries(settings.usage.byDay)) {
            const [y, m, d] = key.split('-').map(Number);
            const date = new Date(y, m - 1, d);
            const cost = Object.entries(day.models || {}).reduce((sum, [mid, data]) => sum + context.calculateCost(data.input || 0, data.output || 0, mid), 0);
            if (context.getWeekKey(date) === week) costs.week += cost;
            if (context.getMonthKey(date) === month) costs.month += cost;
        }
        return { week: `$${costs.week.toFixed(2)}`, month: `$${costs.month.toFixed(2)}` };
    };
    return { context, counts, texts, get usage() { return settings.usage; }, settings, prices, bruteForce, tick: ms => { clock += ms; } };
}

function assertCostsMatch(ui) {
    const expected = ui.bruteForce();
    assert.equal(ui.texts['#token-usage-week-cost'], expected.week);
    assert.equal(ui.texts['#token-usage-month-cost'], expected.month);
}

test('changing the source filter renders the chart and summary once', () => {
    const ui = uiRuntime({ days: 5 });
    ui.context.updateSourceFilter('openai');
    assert.deepEqual([ui.counts.chart, ui.counts.summary, ui.counts.chartData], [1, 1, 1]);
    assert.equal(ui.context.currentSourceFilter, 'openai');
});

test('a hidden panel still defers usage updates, and a filter change there still renders', () => {
    const ui = uiRuntime({ days: 5, visible: false });
    ui.context.updateUIStats();
    assert.deepEqual([ui.counts.chart, ui.counts.summary, ui.counts.miniview], [0, 0, 1]);
    assert.equal(ui.texts['#token-usage-week-cost'], undefined);
    ui.context.updateSourceFilter('openai');
    assert.deepEqual([ui.counts.chart, ui.counts.summary], [1, 1]);
});

test('an update with computed stats does not build them again', () => {
    const ui = uiRuntime({ days: 5 });
    ui.context.updateUIStats(ui.context.getUsageStats());
    assert.equal(ui.counts.stats, 1);
    ui.context.updateUIStats();
    assert.equal(ui.counts.stats, 2);
});

test('repeat visible updates do not classify all of history, and costs stay exact', () => {
    const ui = uiRuntime();
    ui.context.updateUIStats();
    assertCostsMatch(ui);
    const firstScan = ui.counts.formatToParts;
    assert.ok(firstScan >= 3000, `first update classifies every day (${firstScan})`);

    const before = ui.counts.formatToParts;
    for (let i = 0; i < 10; i++) ui.context.updateUIStats();
    assert.ok(ui.counts.formatToParts - before <= 10 * 2, `${ui.counts.formatToParts - before} key calculations for 10 updates`);
    assertCostsMatch(ui);
});

test('period costs follow price changes, new usage, new days, imports, resets and rollovers', () => {
    const ui = uiRuntime({ days: 400 });
    const { context, prices } = ui;
    const record = () => context.addToUsageBuckets({ input: 5e6, output: 1e6, reasoning: 0 }, { messageCount: 1 }, null, 'paid', null);
    context.updateUIStats();

    // Price change: costs are always recalculated
    prices.paid = { in: 10, out: 20 };
    context.updateUIStats();
    assertCostsMatch(ui);

    // More usage on a known day
    record();
    context.updateUIStats();
    assertCostsMatch(ui);

    // The first usage of a new day, in the same week
    ui.tick(86400000);
    context.updateUIStats();
    record();
    context.updateUIStats();
    assertCostsMatch(ui);
    assert.ok(Object.keys(ui.usage.byDay).includes('2026-11-06'));

    // An imported day that was not in history
    const imported = { '2026-11-20': { total: 9e6, models: { paid: { input: 9e6, output: 0, total: 9e6 } } } };
    context.importUsageData(JSON.stringify({ version: '1.0', usage: { byDay: imported } }));
    context.updateUIStats();
    assertCostsMatch(ui);
    assert.equal(ui.usage.byDay['2026-11-20'].total, 9e6);

    // Week, then month rollover with no new usage
    ui.tick(5 * 86400000);
    context.updateUIStats();
    assertCostsMatch(ui);
    ui.tick(25 * 86400000);
    context.updateUIStats();
    assertCostsMatch(ui);

    // Reset All replaces the usage object
    ui.settings.usage = { byDay: {}, session: {}, allTime: {}, byModel: {} };
    context.updateUIStats();
    assert.equal(ui.texts['#token-usage-month-cost'], '$0.00');
});
