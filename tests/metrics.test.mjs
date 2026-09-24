import test from 'node:test';
import assert from 'node:assert/strict';
import * as metrics from '../metrics.js';

test('generation stats derive attempts, successes and rate; legacy entries count as zero', () => {
    assert.deepEqual(metrics.generationStats({ messageCount: 189, stopped: 5, failed: 8 }), {
        generations: 189, stopped: 5, failed: 8, succeeded: 184, attempts: 197, successRate: 184 / 197,
    });
    assert.deepEqual(metrics.generationStats({ messageCount: 12 }), {
        generations: 12, stopped: 0, failed: 0, succeeded: 12, attempts: 12, successRate: 1,
    });
    assert.equal(metrics.generationStats({}).successRate, null);
    assert.equal(metrics.generationStats(undefined).attempts, 0);
    assert.equal(metrics.generationStats({ failed: 2 }).successRate, 0);
});

test('bumpCounts adds to missing fields and leaves zero increments untouched', () => {
    const entry = { input: 5, output: 3, total: 8 };
    metrics.bumpCounts(entry, { messageCount: 1 });
    assert.deepEqual(entry, { input: 5, output: 3, total: 8, messageCount: 1 });
    metrics.bumpCounts(entry, { messageCount: 1, stopped: 1 });
    metrics.bumpCounts(entry, { failed: 1 });
    assert.deepEqual(entry, { input: 5, output: 3, total: 8, messageCount: 2, stopped: 1, failed: 1 });
});

test('outcome completeness is strictly after the bucket in which tracking began', () => {
    assert.equal(metrics.hasCompleteOutcomes('2026-09-24', '2026-09-24'), false);
    assert.equal(metrics.hasCompleteOutcomes('2026-09-25', '2026-09-24'), true);
    assert.equal(metrics.hasCompleteOutcomes('2026-09-23', '2026-09-24'), false);
    assert.equal(metrics.hasCompleteOutcomes('2026-09-24T21', '2026-09-24T20'), true);
    assert.equal(metrics.hasCompleteOutcomes('2026-09-24T09', '2026-09-24T10'), false);
    assert.equal(metrics.hasCompleteOutcomes('2026-09-25', null), false);
});

test('generation chart points use bucket or source counts and only counted models', () => {
    const bucket = {
        messageCount: 10, stopped: 1, failed: 2,
        models: { a: { total: 50, messageCount: 6 }, legacy: { total: 20 } },
        sources: { openrouter: { messageCount: 4, failed: 1, models: { a: { messageCount: 4 } } }, old: { total: 9 } },
    };
    const all = metrics.generationPoint(bucket);
    assert.equal(all.generations, 10);
    assert.equal(all.attempts, 12);
    assert.deepEqual(all.modelCounts, { a: 6 });
    const source = metrics.generationPoint(bucket, 'openrouter');
    assert.equal(source.generations, 4);
    assert.equal(source.failed, 1);
    assert.deepEqual(source.modelCounts, { a: 4 });
    assert.equal(metrics.generationPoint(bucket, 'old').generations, 0);
    assert.equal(metrics.generationPoint(bucket, 'missing').generations, 0);
    assert.equal(metrics.generationPoint(undefined).generations, 0);
});

test('count axis never uses fractional steps', () => {
    assert.deepEqual(metrics.countAxisScale(0), { step: 1, niceMax: 5 });
    for (const max of [1, 2, 3, 7, 10, 31, 184, 2500]) {
        const { step, niceMax } = metrics.countAxisScale(max);
        assert.ok(Number.isInteger(step) && step >= 1, `step for ${max}`);
        assert.ok(niceMax >= max && niceMax % step === 0, `niceMax for ${max}`);
    }
});

function harness(options = {}) {
    let clock = 1_000_000;
    const timers = [];
    const resolved = [];
    const tracker = metrics.createAttemptTracker({
        now: () => clock,
        setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }),
        onResolve: (attempt, status, details) => resolved.push({ id: attempt.id, kind: attempt.kind, status, details }),
        ...options,
    });
    return {
        tracker,
        resolved,
        advance(ms) {
            clock += ms;
            for (const timer of timers.filter(t => t.at <= clock)) {
                timers.splice(timers.indexOf(timer), 1);
                timer.fn();
            }
        },
    };
}

test('non-streaming success: message resolves before the end event; the grace check is a no-op', () => {
    const h = harness();
    const main = h.tracker.begin('main', { genType: 'normal' });
    assert.equal(h.tracker.bindRequest({ streaming: false }), main);
    h.tracker.requestSettled(main, 'ok');
    assert.equal(h.tracker.resolve(main, 'succeeded', { messageIndex: 3 }), true);
    h.tracker.generationEnded();
    h.advance(5000);
    assert.deepEqual(h.resolved, [{ id: main.id, kind: 'main', status: 'succeeded', details: { messageIndex: 3 } }]);
});

test('non-streaming response without a message is failed after the grace period', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest();
    h.tracker.requestSettled(main, 'ok');
    h.tracker.generationEnded();
    h.advance(1999);
    assert.equal(h.resolved.length, 0);
    h.advance(1);
    assert.deepEqual(h.resolved.map(r => r.status), ['failed']);
});

test('request failure resolves immediately and later events are no-ops', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest();
    h.tracker.requestSettled(main, 'failed');
    assert.equal(h.tracker.resolve(main, 'succeeded'), false);
    assert.equal(h.tracker.requestSettled(main, 'aborted'), false);
    h.tracker.generationEnded();
    h.advance(5000);
    assert.deepEqual(h.resolved.map(r => r.status), ['failed']);
    assert.equal(h.tracker.openMain(), null);
});

test('streaming success: end event before the message does not fail the attempt', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest({ streaming: true });
    h.tracker.requestSettled(main, 'ok');
    h.tracker.generationEnded({ streamError: false });
    h.advance(10_000);
    assert.equal(h.resolved.length, 0);
    assert.equal(h.tracker.resolve(h.tracker.openMain(), 'succeeded'), true);
    assert.deepEqual(h.resolved.map(r => r.status), ['succeeded']);
});

test('streaming seen only at the end event is not failed by the grace check or pending sweep', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    // request never matched, but a live stream was observed
    h.advance(60_000);
    h.tracker.markStreaming(main);
    h.tracker.generationEnded();
    h.advance(10_000);
    assert.equal(h.resolved.length, 0);
    h.tracker.resolve(main, 'succeeded');
    h.tracker.markStreaming(main);
    assert.deepEqual(h.resolved.map(r => r.status), ['succeeded']);
});

test('streaming mid-stream error fails at the end event', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest({ streaming: true });
    h.tracker.requestSettled(main, 'ok');
    h.tracker.generationEnded({ streamError: true });
    assert.deepEqual(h.resolved.map(r => r.status), ['failed']);
});

test('stream error flag is ignored for non-streaming attempts', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest({ streaming: false });
    h.tracker.generationEnded({ streamError: true });
    assert.equal(h.resolved.length, 0);
    h.tracker.requestSettled(main, 'aborted');
    assert.deepEqual(h.resolved.map(r => r.status), ['stopped']);
});

test('user stop on a non-streaming request is stopped exactly once, never failed', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.bindRequest();
    // stopGeneration(): hide stop button (end event), then emit GENERATION_STOPPED
    h.tracker.generationEnded();
    h.tracker.resolve(h.tracker.openMain(), 'stopped', { partialText: '' });
    h.tracker.requestSettled(main, 'aborted');
    h.advance(5000);
    assert.deepEqual(h.resolved.map(r => r.status), ['stopped']);
});

test('user stop before the request is sent is stopped, not swept as failed', () => {
    const h = harness();
    h.tracker.begin('main');
    h.tracker.generationEnded();
    h.tracker.resolve(h.tracker.openMain(), 'stopped');
    h.advance(20_000);
    assert.deepEqual(h.resolved.map(r => r.status), ['stopped']);
});

test('a new main attempt supersedes an older open one', () => {
    const h = harness();
    const toolRound = h.tracker.begin('main');
    h.tracker.bindRequest();
    h.tracker.requestSettled(toolRound, 'ok');
    const followUp = h.tracker.begin('main');
    assert.deepEqual(h.resolved.map(r => [r.id, r.status]), [[toolRound.id, 'succeeded']]);

    const next = h.tracker.begin('main');
    assert.deepEqual(h.resolved.map(r => [r.id, r.status]), [[toolRound.id, 'succeeded'], [followUp.id, 'failed']]);
    assert.equal(h.tracker.openMain(), next);
});

test('quiet and main attempts bind requests in order and resolve independently', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    const quiet = h.tracker.begin('quiet');
    assert.equal(h.tracker.bindRequest({ streaming: true }), main);
    assert.equal(h.tracker.bindRequest({ streaming: false }), quiet);
    assert.equal(h.tracker.bindRequest(), null);
    h.tracker.requestSettled(quiet, 'ok');
    h.tracker.resolve(quiet, 'succeeded', { text: 'summary' });
    h.tracker.requestSettled(main, 'ok');
    assert.deepEqual(h.resolved, [{ id: quiet.id, kind: 'quiet', status: 'succeeded', details: { text: 'summary' } }]);
    assert.equal(h.tracker.openMain(), main);
    assert.equal(h.tracker.oldestOpen('quiet'), null);
});

test('a quiet attempt does not supersede the open main attempt', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.begin('quiet');
    assert.equal(h.resolved.length, 0);
    assert.equal(h.tracker.openMain(), main);
});

test('attempts that never send a request are swept only when old enough', () => {
    const h = harness();
    const stale = h.tracker.begin('quiet');
    h.advance(9000);
    const fresh = h.tracker.begin('quiet');
    h.tracker.generationEnded();
    h.advance(2000);
    assert.deepEqual(h.resolved.map(r => r.id), [stale.id]);
    assert.equal(h.tracker.oldestOpen('quiet'), fresh);
    h.advance(20_000);
    h.tracker.generationEnded();
    h.advance(2000);
    assert.deepEqual(h.resolved.map(r => [r.id, r.status]), [[stale.id, 'failed'], [fresh.id, 'failed']]);
});

test('an in-flight request is not swept by the end event', () => {
    const h = harness();
    const quiet = h.tracker.begin('quiet');
    h.tracker.bindRequest();
    h.advance(60_000);
    h.tracker.generationEnded();
    h.advance(2000);
    assert.equal(h.resolved.length, 0);
    h.tracker.requestSettled(quiet, 'failed');
    assert.deepEqual(h.resolved.map(r => r.status), ['failed']);
});

test('requests do not bind to attempts older than the bind window or already resolved', () => {
    const h = harness({ bindWindowMs: 1000 });
    const old = h.tracker.begin('quiet');
    h.advance(1001);
    assert.equal(h.tracker.bindRequest(), null);
    h.tracker.resolve(old, 'failed');
    const next = h.tracker.begin('quiet');
    assert.equal(h.tracker.bindRequest(), next);
});

test('onResolve fires exactly once per attempt', () => {
    const h = harness();
    const main = h.tracker.begin('main');
    h.tracker.resolve(main, 'stopped');
    h.tracker.resolve(main, 'failed');
    h.tracker.resolve(main, 'succeeded');
    h.tracker.begin('main');
    assert.deepEqual(h.resolved.map(r => [r.id, r.status]), [[main.id, 'stopped']]);
});
