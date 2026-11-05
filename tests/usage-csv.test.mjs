import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageCsv } from '../usage-csv.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('exports custom scopes and metrics without migrating or mutating stored history', () => {
    const bucket = { input: 10, output: 5, reasoning: 3, total: 18, messageCount: 2, stopped: 1, failed: 4 };
    const usage = {
        byDay: { '2026-10-10': { ...bucket, models: { m: { input: 10, output: 8, total: 18 } },
            sources: { custom: { total: 18, models: { m: { input: 10, output: 8, total: 18 } } } } } },
        byHour: { '2026-10-10T12': bucket }, byChat: { chat: bucket },
        byModel: { m: bucket }, bySource: { custom: bucket },
        session: bucket, allTime: bucket, outcomesTrackedSince: '2026-09-24T20:00:00Z',
    };
    const before = structuredClone(usage);
    const csv = buildUsageCsv(usage, (input, output) => (input + output) / 1000);
    assert.deepEqual(usage, before);
    assert.match(csv, /day,2026-10-10,,,10,5,3,18,2,1,4,,2026-09-24/);
    assert.match(csv, /day_model,2026-10-10,m,,10,8,,18,,,,0.01800000/);
    for (const scope of ['hour', 'chat', 'model', 'source', 'session', 'allTime', 'day_source_model']) {
        assert.ok(csv.split('\r\n').some(line => line.startsWith(`${scope},`)), scope);
    }
});

test('legacy totals and missing counters remain distinguishable from recorded zero', () => {
    const csv = buildUsageCsv({ byDay: { day: { total: 7, models: { legacy: 7, zero: { input: 0, output: 0, total: 0, stopped: 0, failed: 0 } } } } });
    assert.match(csv, /day_model,day,legacy,,,,,7,,,,,/);
    assert.match(csv, /day_model,day,zero,,0,0,,0,,0,0,,/);
});

test('CSV escapes quotes/newlines and neutralizes formula labels', () => {
    const csv = buildUsageCsv({ byChat: { '=HYPERLINK("bad")\nline': { total: 1 }, '@name': { total: 2 } } });
    assert.ok(csv.includes('"\'=HYPERLINK(""bad"")\nline"'));
    assert.ok(csv.includes("chat,'@name,"));
});

test('costs use the caller pricing resolver without changing pricing or billing totals', () => {
    const calls = [];
    const csv = buildUsageCsv({ byModel: { custom: { input: 2, output: 3 }, free: { input: 0, output: 0 } } }, (...args) => {
        calls.push(args); return args[2] === 'free' ? 0 : 0.123;
    });
    assert.deepEqual(calls, [[2, 3, 'custom'], [0, 0, 'free']]);
    assert.ok(csv.includes('0.12300000'));
    assert.ok(csv.includes('0.00000000'));
});

test('the real slash command downloads CSV and retains JSON import/export commands', async () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('function registerSlashCommands()');
    const commands = new Map();
    let blob, timer, revoked, clicked = false, removed = false;
    const link = { click() { clicked = true; }, remove() { removed = true; } };
    const context = vm.createContext({ usageRevision: 0,
        ARGUMENT_TYPE: { STRING: 'string' }, SlashCommandParser: { addCommandObject: command => commands.set(command.name, command) },
        SlashCommand: { fromProps: props => props }, SlashCommandArgument: { fromProps: props => props },
        buildUsageCsv, Blob, getSettings: () => ({ usage: { byChat: { custom: { total: 42 } } } }),
        calculateCost: () => 0, getDayKey: () => '2026-10-10',
        URL: { createObjectURL: value => { blob = value; return 'blob:csv'; }, revokeObjectURL: url => { revoked = url; } },
        document: { createElement: () => link, body: { appendChild() {} } },
        setTimeout: callback => { timer = callback; },
    });
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2) + '\nregisterSlashCommands();', context);
    assert.ok(commands.has('tokenexport')); assert.ok(commands.has('tokenimport'));
    assert.match(await commands.get('tokencsv').callback(), /CSV exported/);
    assert.ok(clicked && removed); assert.equal(link.download, 'token-usage-2026-10-10.csv');
    assert.match(await blob.text(), /chat,custom/);
    assert.equal(revoked, undefined); timer(); assert.equal(revoked, 'blob:csv');
});
