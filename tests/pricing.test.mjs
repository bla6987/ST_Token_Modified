import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as pricing from '../pricing.js';

const state = () => ({ modelPrices: {}, sharedModelPrices: {}, modelPriceGroups: {} });
const rate = { in: 3, out: 15 };
const model = 'anthropic/claude-3.7-sonnet';
const group = pricing.suggestedPriceGroup(model);

test('bulk search updates all matching IDs across pages, replacing overrides but excluding unrelated aliases', () => {
    const s = state();
    const models = Array.from({ length: 125 }, (_, i) => `provider-${i}/claude-3.7-sonnet`);
    s.sharedModelPrices[group] = { in: 50, out: 100 };
    s.modelPrices[models[0]] = { in: 99, out: 99 };
    s.modelPriceGroups.alias = group;
    s.modelPrices.unrelated = { in: 6, out: 7 };
    const updated = pricing.applyMatchingPrices(s, models, '  CLAUDE-3.7  ', '3', '15');
    assert.equal(updated.length, 125);
    for (const id of models) assert.deepEqual(pricing.configuredPrice(s, id).price, rate);
    assert.deepEqual(pricing.configuredPrice(s, 'alias').price, { in: 50, out: 100 });
    assert.deepEqual(s.modelPrices.unrelated, { in: 6, out: 7 });
    assert.equal(pricing.matchingPriceModels(s, models, 'provider-1/').length, 1);
});

test('bulk search supports zero, empty searches and configured-only IDs; invalid inputs make no changes', () => {
    const s = state();
    s.modelPrices.saved = rate;
    s.modelPriceGroups.alias = group;
    assert.deepEqual(pricing.applyMatchingPrices(s, ['tracked'], '', '0', '0'), ['alias', 'saved', 'tracked']);
    assert.deepEqual(s.modelPrices.saved, { in: 0, out: 0 });
    const before = JSON.stringify(s);
    assert.throws(() => pricing.applyMatchingPrices(s, ['tracked'], '', '', '3'), /Enter both/);
    assert.equal(JSON.stringify(s), before);
    assert.deepEqual(pricing.applyMatchingPrices(s, ['tracked'], 'missing', '3', '15'), []);
    assert.equal(JSON.stringify(s), before);
});

test('simple provider paths match while versions and qualifiers stay distinct', () => {
    for (const id of ['claude-3.7-sonnet', 'proxy/anthropic/claude-3.7-sonnet', 'ANTHROPIC/CLAUDE-3.7-SONNET']) {
        assert.equal(pricing.suggestedPriceGroup(id), group);
    }
    for (const id of ['claude-3.7-sonnet:free', 'claude-3.7-sonnet-thinking', 'claude-3.7-sonnet-20250219', 'claude-3.5-sonnet', 'claude-3.7-sonnet/q4', 'other-v2/claude-3.7-sonnet']) {
        assert.notEqual(pricing.suggestedPriceGroup(id), group);
    }
    assert.equal(pricing.suggestedPriceGroup('owner/model'), 'exact:owner/model');
    assert.equal(pricing.suggestedPriceGroup('owner/model/v1'), 'exact:owner/model/v1');
});

test('shared changes reach existing and future variants; exact overrides win', () => {
    const s = state();
    pricing.saveSharedPrice(s, group, rate);
    assert.deepEqual(pricing.configuredPrice(s, model), { price: rate, source: 'Shared' });
    assert.deepEqual(pricing.configuredPrice(s, 'new-provider/' + model).price, rate);
    s.modelPrices[model] = { in: 0, out: 0 };
    pricing.saveSharedPrice(s, group, { in: 4, out: 20 });
    assert.deepEqual(pricing.configuredPrice(s, model), { price: { in: 0, out: 0 }, source: 'Override' });
    delete s.modelPrices[model];
    assert.deepEqual(pricing.configuredPrice(s, model).price, { in: 4, out: 20 });
});

test('first activation adopts identical legacy copies and preserves different rates and usage', () => {
    const s = state();
    s.usage = { byModel: { [model]: { input: 12, output: 4 } } };
    s.modelPrices[model] = { in: '3', out: '15' };
    s.modelPrices['proxy/' + model] = { in: 8, out: 25 };
    const usage = JSON.stringify(s.usage);
    assert.equal(pricing.saveSharedPrice(s, group, rate), 1);
    assert.equal(pricing.configuredPrice(s, model).source, 'Shared');
    assert.equal(pricing.configuredPrice(s, 'proxy/' + model).source, 'Override');
    // An intentional override equal to the shared rate must still survive later saves.
    s.modelPrices[model] = { ...rate };
    assert.equal(pricing.saveSharedPrice(s, group, rate), 0);
    assert.equal(pricing.configuredPrice(s, model).source, 'Override');
    assert.equal(JSON.stringify(s.usage), usage);
});

test('manual aliases resolve directly and can opt out of future automatic matching', () => {
    const s = state();
    pricing.saveSharedPrice(s, group, rate);
    s.modelPriceGroups['My custom alias'] = group;
    assert.deepEqual(pricing.configuredPrice(s, 'My custom alias').price, rate);
    s.modelPriceGroups[model] = 'exact:' + model;
    assert.equal(pricing.configuredPrice(s, model), null);
    assert.equal(pricing.configuredPrice(s, 'proxy/' + model).source, 'Shared');
});

test('configured groups and aliases survive even without tracked usage', () => {
    const s = state();
    pricing.saveSharedPrice(s, group, rate);
    s.modelPriceGroups.alias = group;
    s.modelPrices['other-model-1'] = rate;
    const groups = pricing.collectPriceGroups(s, [model, 'proxy/' + model]);
    assert.equal(groups.length, 2);
    assert.equal(groups.find(g => g.id === group).models.length, 3);
    assert.deepEqual(pricing.collectPriceGroups({ ...state(), sharedModelPrices: { [group]: rate } }, [])[0].models, []);
});

test('prices reject partial, negative and non-finite entries while allowing zero and small rates', () => {
    for (const value of ['', ' ', '-1', 'NaN', 'Infinity', '1e999', '3abc', '0xff']) {
        assert.equal(pricing.parsePrice(value, '1'), null);
        assert.equal(pricing.parsePrice('1', value), null);
    }
    assert.deepEqual(pricing.parsePrice('0', '.0001'), { in: 0, out: 0.0001 });
    assert.deepEqual(pricing.parsePrice('1e-6', '2.5'), { in: 0.000001, out: 2.5 });
});

// Exercise the actual extension resolver and backup functions without running
// SillyTavern startup, making API requests, or touching real usage/settings.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
function runtime(settings) {
    const context = vm.createContext({
        ...pricing, settings, getSettings: () => settings,
        modelPriceCache: new Map(), modelConfigState: {}, modelConfigPriceDrafts: new Map(),
        saveSettings() {}, getUsageStats: () => ({}), eventSource: { emit() {} },
        getCurrentEasternTime: () => new Date('2026-09-12T12:00:00Z'), extensionName: 'token-usage-tracker',
        console: { log() {} },
    });
    for (const name of ['invalidateModelPriceCache', 'getModelPrice', 'calculateCost', 'exportUsageData', 'importUsageData']) {
        vm.runInContext(extract(name), context);
    }
    return context;
}

test('actual cost resolver uses override > shared > OpenRouter and invalidates cached rates', () => {
    const s = state();
    s.openRouterPrices = { data: { [model]: { prompt: '0.000001', completion: '0.000002' } } };
    const r = runtime(s);
    assert.equal(r.calculateCost(1e6, 1e6, model), 3);
    pricing.saveSharedPrice(s, group, rate);
    r.invalidateModelPriceCache();
    assert.equal(r.calculateCost(1e6, 1e6, model), 18);
    s.modelPrices[model] = { in: 0, out: 0 };
    r.invalidateModelPriceCache();
    assert.equal(r.calculateCost(1e6, 1e6, model), 0);
    delete s.modelPrices[model];
    delete s.sharedModelPrices[group];
    r.invalidateModelPriceCache();
    assert.equal(r.calculateCost(1e6, 1e6, model), 3);
});

test('actual bulk click uses the live search before debounce, clears affected drafts, and refreshes cached costs', () => {
    const s = { ...state(), usage: { byModel: { 'provider/model-1': {}, 'provider/model-2': {} } } };
    s.modelPrices['provider/model-1'] = { in: 90, out: 90 };
    const r = runtime(s);
    const elements = new Map();
    r.$ = selector => {
        if (!elements.has(selector)) elements.set(selector, {
            value: '', handlers: {}, off() { return this; },
            on(event, handler) { this.handlers[event] = handler; return this; },
            val() { return this.value; },
        });
        return elements.get(selector);
    };
    r.modelConfigSearchTimer = 123;
    r.clearTimeout = () => {};
    r.getUsageStats = () => s.usage;
    r.modelConfigState.query = 'model-2';
    r.modelConfigState.page = 3;
    r.modelConfigPriceDrafts.set('model:provider/model-1', { in: '88', out: '88' });
    r.modelConfigPriceDrafts.set('model:provider/model-2', { in: '77', out: '77' });
    let refreshes = 0;
    r.updateUIStats = () => { refreshes++; };
    r.scheduleModelConfigRender = () => {};
    r.toastr = { success() {}, warning(message) { assert.fail(message); } };
    vm.runInContext(extract('refreshPricing'), r);
    vm.runInContext(extract('bindModelConfigControls'), r);
    r.bindModelConfigControls();
    r.$('#token-usage-model-search').value = ' MODEL-1 ';
    r.$('#token-usage-bulk-in').value = '3';
    r.$('#token-usage-bulk-out').value = '15';
    assert.equal(r.calculateCost(1e6, 1e6, 'provider/model-1'), 180);
    r.$('#token-usage-bulk-apply').handlers['click.tokenUsageConfig']();
    assert.equal(r.calculateCost(1e6, 1e6, 'provider/model-1'), 18);
    assert.equal(Object.hasOwn(s.modelPrices, 'provider/model-2'), false);
    assert.equal(r.modelConfigPriceDrafts.has('model:provider/model-1'), false);
    assert.equal(r.modelConfigPriceDrafts.has('model:provider/model-2'), true);
    assert.equal(r.modelConfigState.query, 'model-1');
    assert.equal(r.modelConfigState.page, 1);
    assert.equal(refreshes, 1);
});

test('actual export/import restores removed overrides and links exactly', () => {
    const s = { ...state(), usage: {}, modelColors: {} };
    pricing.saveSharedPrice(s, group, rate);
    s.modelPriceGroups.alias = group;
    const r = runtime(s);
    const backup = JSON.stringify(r.exportUsageData());
    s.modelPrices[model] = { in: 9, out: 99 };
    s.modelPriceGroups.alias = 'exact:alias';
    r.importUsageData(backup);
    assert.equal(pricing.configuredPrice(s, model).source, 'Shared');
    assert.equal(pricing.priceGroupFor(s, 'alias'), group);
    assert.equal(r.calculateCost(1e6, 1e6, 'alias'), 18);
});

test('old pricing imports still work and malformed new backups fail before usage changes', () => {
    const s = { ...state(), usage: { allTime: { total: 1 } } };
    const r = runtime(s);
    r.importUsageData(JSON.stringify({ version: '1.0', usage: {}, modelPrices: { [model]: rate } }));
    assert.equal(r.calculateCost(1e6, 1e6, model), 18);
    assert.throws(() => r.importUsageData(JSON.stringify({ version: '1.1', usage: { allTime: { total: 999 } }, modelPrices: {}, sharedModelPrices: {}, modelPriceGroups: { alias: 12 } })), /Invalid pricing backup/);
    assert.equal(s.usage.allTime.total, 1);
});
