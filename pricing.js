// Shared pricing is independent of usage tracking: exact model IDs stay intact.
export function suggestedPriceGroup(modelId) {
    const id = String(modelId);
    const parts = id.split('/');
    const leaf = parts.at(-1);
    // Only strip simple provider/organization path prefixes from versioned model
    // names. Never strip suffixes, dates, quantizations or path-based variants.
    if (/^[a-z][a-z0-9._:-]*-[a-z0-9._:-]*\d[a-z0-9._:-]*$/i.test(leaf)
        && parts.slice(0, -1).every(part => /^[a-z][a-z._-]*$/i.test(part))) {
        return `suffix:${leaf.toLowerCase()}`;
    }
    return `exact:${id}`;
}

export function priceGroupFor(settings, modelId) {
    const links = settings.modelPriceGroups || {};
    return Object.hasOwn(links, modelId) ? links[modelId] : suggestedPriceGroup(modelId);
}

export function priceGroupLabel(groupId) {
    return groupId.slice(groupId.indexOf(':') + 1);
}

export function parsePrice(input, output) {
    const values = [input, output].map(value => String(value ?? '').trim());
    if (values.some(value => !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return null;
    const [priceIn, priceOut] = values.map(Number);
    return Number.isFinite(priceIn) && Number.isFinite(priceOut)
        ? { in: priceIn, out: priceOut } : null;
}

export function configuredPrice(settings, modelId) {
    if (Object.hasOwn(settings.modelPrices || {}, modelId)) {
        return { price: settings.modelPrices[modelId], source: 'Override' };
    }
    const group = priceGroupFor(settings, modelId);
    if (Object.hasOwn(settings.sharedModelPrices || {}, group)) {
        return { price: settings.sharedModelPrices[group], source: 'Shared' };
    }
    return null;
}

export function collectPriceGroups(settings, trackedModels) {
    const groups = new Map();
    const addGroup = id => {
        if (!groups.has(id)) groups.set(id, { id, name: priceGroupLabel(id), models: [] });
        return groups.get(id);
    };
    for (const id of Object.keys(settings.sharedModelPrices || {})) addGroup(id);
    const models = new Set([
        ...trackedModels,
        ...Object.keys(settings.modelPrices || {}),
        ...Object.keys(settings.modelPriceGroups || {}),
    ]);
    for (const model of [...models].sort()) addGroup(priceGroupFor(settings, model)).models.push(model);
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function saveSharedPrice(settings, groupId, price) {
    settings.sharedModelPrices ||= {};
    settings.modelPrices ||= {};
    const firstSave = !Object.hasOwn(settings.sharedModelPrices, groupId);
    let adopted = 0;
    // Adopt identical legacy prices only when first activating the group.
    // Subsequent edits must preserve all explicitly configured overrides.
    if (firstSave) {
        for (const [model, existing] of Object.entries(settings.modelPrices)) {
            if (priceGroupFor(settings, model) === groupId
                && Number(existing?.in) === price.in && Number(existing?.out) === price.out) {
                delete settings.modelPrices[model];
                adopted++;
            }
        }
    }
    settings.sharedModelPrices[groupId] = { ...price };
    return adopted;
}

export function readPricingSnapshot(data) {
    if (!Object.hasOwn(data, 'sharedModelPrices') && !Object.hasOwn(data, 'modelPriceGroups')) return null;
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const validGroup = id => typeof id === 'string' && /^(suffix|exact):.+/.test(id);
    for (const key of ['modelPrices', 'sharedModelPrices', 'modelPriceGroups']) {
        if (!record(data[key])) throw new Error(`Invalid pricing backup: ${key}`);
    }
    const prices = key => Object.fromEntries(Object.entries(data[key]).map(([id, price]) => {
        const parsed = record(price) && parsePrice(price.in, price.out);
        if (!parsed || (key === 'sharedModelPrices' && !validGroup(id))) {
            throw new Error(`Invalid pricing backup: ${key}`);
        }
        return [id, parsed];
    }));
    if (Object.values(data.modelPriceGroups).some(group => !validGroup(group))) {
        throw new Error('Invalid pricing backup: modelPriceGroups');
    }
    return {
        modelPrices: prices('modelPrices'),
        sharedModelPrices: prices('sharedModelPrices'),
        modelPriceGroups: { ...data.modelPriceGroups },
    };
}
