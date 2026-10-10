// Read-only CSV view of this fork's existing history. JSON remains the backup format.
function cell(value) {
    let text = String(value ?? '');
    // Keep spreadsheet apps from interpreting externally supplied labels as formulas.
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows are separate views of the same history; do not sum across scopes. */
export function buildUsageCsv(usage = {}, estimateCost = null) {
    const rows = [[
        'scope', 'key', 'model', 'source', 'input_tokens', 'output_tokens',
        'reasoning_tokens', 'total_tokens', 'generations', 'stopped', 'failed',
        'estimated_cost_usd', 'outcomes_tracked_since',
    ]];
    const append = (scope, key, bucket, model = '', source = '') => {
        if (typeof bucket === 'number') bucket = { total: bucket }; // legacy model totals
        if (!bucket || typeof bucket !== 'object') return;
        const numeric = name => Number.isFinite(bucket[name]) ? bucket[name] : '';
        const cost = model && estimateCost && Number.isFinite(bucket.input) && Number.isFinite(bucket.output)
            ? estimateCost(bucket.input, bucket.output, model) : null;
        rows.push([
            scope, key, model, source, numeric('input'), numeric('output'),
            numeric('reasoning'), numeric('total'), numeric('messageCount'),
            numeric('stopped'), numeric('failed'),
            Number.isFinite(cost) ? cost.toFixed(8) : '', usage.outcomesTrackedSince || '',
        ]);
    };
    const appendBucket = (scope, key, bucket) => {
        append(scope, key, bucket);
        for (const [model, data] of Object.entries(bucket?.models || {}).sort()) append(`${scope}_model`, key, data, model);
        for (const [source, data] of Object.entries(bucket?.sources || {}).sort()) {
            append(`${scope}_source`, key, data, '', source);
            for (const [model, modelData] of Object.entries(data?.models || {}).sort()) {
                append(`${scope}_source_model`, key, modelData, model, source);
            }
        }
    };
    for (const scope of ['session', 'allTime']) {
        if (usage[scope]) appendBucket(scope, '', usage[scope]);
    }
    for (const [property, scope] of Object.entries({
        byDay: 'day', byHour: 'hour', byWeek: 'week', byMonth: 'month', byChat: 'chat',
    })) {
        for (const [key, bucket] of Object.entries(usage[property] || {}).sort()) appendBucket(scope, key, bucket);
    }
    for (const [model, bucket] of Object.entries(usage.byModel || {}).sort()) append('model', '', bucket, model);
    for (const [source, bucket] of Object.entries(usage.bySource || {}).sort()) append('source', '', bucket, '', source);
    return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
