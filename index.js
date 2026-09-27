/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting (non-blocking)
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
// Namespace import: optional helpers must not break loading on older SillyTavern versions
import * as stScript from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getFriendlyTokenizerName } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { getChatCompletionModel, oai_settings } from '../../../openai.js';
import { textgenerationwebui_settings as textgen_settings } from '../../../textgen-settings.js';
import { parsePrice, configuredPrice, collectPriceGroups, saveSharedPrice, readPricingSnapshot, matchingPriceModels, applyMatchingPrices } from './pricing.js';
import { bumpCounts, generationStats, generationPoint, hasCompleteOutcomes, countAxisScale, createAttemptTracker } from './metrics.js';
import { createErrorStore, normalizeErrorStore, routeFromRequest, payloadError, payloadProvider, describeError, statusFromReason, createStreamScanner, recordRouteOutcome, erroringRoutes, errorBreakdown, errorLabel } from './errors.js';

const extensionName = 'token-usage-tracker';

const EASTERN_TIMEZONE = 'America/New_York';
let externalTimeOffset = null; // Offset between local time and external time (in ms)
let lastTimeSyncTimestamp = null;
const TIME_SYNC_INTERVAL = 5 * 60 * 1000; // Re-sync every 5 minutes

// Cached Intl.DateTimeFormat instances (avoid re-creating in hot loops)
const _fmtDayDisplay = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, month: 'short', day: 'numeric' });
const _fmtDayFull = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const _fmtHourDisplay = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, hour: 'numeric', hour12: true });
const _fmtHourFull = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', hour12: true });
const _fmtMinute = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

function getEasternParts(date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    });

    const parts = dtf.formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
    };
}

/**
 * Fetch current time from external source (worldtimeapi.org)
 * @returns {Promise<Date|null>} Date object with external time, or null on failure
 */
async function fetchExternalTime() {
    try {
        const response = await fetch(`https://worldtimeapi.org/api/timezone/${EASTERN_TIMEZONE}`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const externalDate = (typeof data?.unixtime === 'number')
            ? new Date(data.unixtime * 1000)
            : new Date(data?.datetime);
        if (Number.isNaN(externalDate.getTime())) {
            throw new Error('Invalid datetime from external time source');
        }
        return externalDate;
    } catch (error) {
        console.warn('[Token Usage Tracker] Failed to fetch external time:', error.message);
        return null;
    }
}

/**
 * Sync time offset with external source
 * Calculates the difference between local system time and external time
 */
async function syncTimeOffset() {
    const externalTime = await fetchExternalTime();
    if (externalTime) {
        const localTime = new Date();
        const offset = externalTime.getTime() - localTime.getTime();
        if (!Number.isFinite(offset)) {
            console.warn('[Token Usage Tracker] External time offset is not finite');
            return false;
        }
        externalTimeOffset = offset;
        lastTimeSyncTimestamp = Date.now();
        console.log(`[Token Usage Tracker] Time synced with external source. Offset: ${externalTimeOffset}ms`);
        return true;
    }
    return false;
}

/**
 * Get current time in Eastern timezone, using external source when available
 * Falls back to local time converted to Eastern if external sync fails
 * @returns {Date} Date object representing current Eastern time
 */
function getCurrentEasternTime() {
    // Check if we need to re-sync (async, non-blocking)
    if (!lastTimeSyncTimestamp || (Date.now() - lastTimeSyncTimestamp > TIME_SYNC_INTERVAL)) {
        syncTimeOffset(); // Fire and forget - don't await
    }

    // NOTE: A JS Date is always an absolute timestamp (ms since epoch).
    // We apply external offset (if available) to correct the timestamp.
    // Eastern timezone handling is done when formatting/deriving parts via Intl.
    if (externalTimeOffset !== null && Number.isFinite(externalTimeOffset)) {
        return new Date(Date.now() + externalTimeOffset);
    }

    return new Date();
}

const defaultSettings = {
    showInTopBar: true,
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Prices per 1M tokens: { "gpt-4o": { in: 2.5, out: 10 }, ... }
    modelPrices: {},
    sharedModelPrices: {}, // Group ID -> shared input/output prices per 1M tokens
    modelPriceGroups: {}, // Explicit model ID -> group ID links (including separate models)
    // OpenRouter auto-fetched pricing cache
    openRouterPrices: {
        data: {},         // { "model-id": { prompt: X, completion: Y } } - per-token pricing
        lastFetched: null // Timestamp of last API fetch
    },
    // Miniview settings
    miniview: {
        pinned: false,
        mode: 'session', // 'session', 'hourly', 'daily'
        position: { bottom: 80, right: 20 }, // Position in pixels
        size: { width: 180, height: null }, // Size in pixels (null = auto height)
    },
    // Accumulated usage data
    usage: {
        session: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {}, startTime: null },
        allTime: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 },
        // Time-based buckets: { "2025-01-15": { input: X, output: Y, total: Z, models: { "gpt-4o": 500, ... } }, ... }
        byDay: {},
        byHour: {},    // "2025-01-15T14": { ... }
        byWeek: {},    // "2025-W03": { ... }
        byMonth: {},   // "2025-01": { ... }
        // Per-chat usage: { "chatId": { input: X, output: Y, ... }, ... }
        byChat: {},
        // Per-model usage: { "gpt-4o": { input: X, output: Y, total: Z, messageCount: N }, ... }
        byModel: {},
        // Per-source usage: { "openai": { input: X, output: Y, total: Z, messageCount: N }, ... }
        bySource: {},
        // When stopped/failed counting began (ISO); older buckets have no outcome data
        outcomesTrackedSince: null,
    },
    // API errors by route (source · endpoint host · model · provider), see errors.js
    errorTracking: createErrorStore(),
};

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    // Deep merge defaults for any missing keys
    const settings = extension_settings[extensionName];
    if (!settings.modelColors) settings.modelColors = {};
    if (!settings.usage) settings.usage = structuredClone(defaultSettings.usage);
    if (!settings.usage.session) settings.usage.session = structuredClone(defaultSettings.usage.session);
    if (!settings.usage.allTime) settings.usage.allTime = structuredClone(defaultSettings.usage.allTime);
    if (!settings.usage.byDay) settings.usage.byDay = {};
    if (!settings.usage.byHour) settings.usage.byHour = {};
    if (!settings.usage.byWeek) settings.usage.byWeek = {};
    if (!settings.usage.byMonth) settings.usage.byMonth = {};
    if (!settings.usage.byChat) settings.usage.byChat = {};
    if (!settings.usage.byModel) settings.usage.byModel = {};
    if (!settings.usage.bySource) settings.usage.bySource = {};
    if (!settings.usage.outcomesTrackedSince) {
        settings.usage.outcomesTrackedSince = getCurrentEasternTime().toISOString();
    }

    // Initialize modelPrices
    if (!settings.modelPrices) settings.modelPrices = {};
    if (!settings.sharedModelPrices) settings.sharedModelPrices = {};
    if (!settings.modelPriceGroups) settings.modelPriceGroups = {};
    settings.errorTracking = normalizeErrorStore(settings.errorTracking);

    // Migration: Convert byDay.models from numeric format to object format
    // Old: models[modelId] = totalTokens (number)
    // New: models[modelId] = { input, output, total }
    for (const dayData of Object.values(settings.usage.byDay)) {
        if (dayData.models) {
            for (const [modelId, value] of Object.entries(dayData.models)) {
                if (typeof value === 'number') {
                    // Migrate: estimate input/output using day's ratio
                    const ratio = dayData.total ? value / dayData.total : 0;
                    dayData.models[modelId] = {
                        input: Math.round((dayData.input || 0) * ratio),
                        output: Math.round((dayData.output || 0) * ratio),
                        total: value
                    };
                }
            }
        }
    }

    // Always reset session on page load - session should not persist across reloads
    settings.usage.session = {
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
        messageCount: 0,
        models: {},
        startTime: getCurrentEasternTime().toISOString(),
    };

    return settings;
}

/**
 * Save settings with debounce
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get current settings
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * Get the current day key (YYYY-MM-DD)
 */
function getDayKey(date = getCurrentEasternTime()) {
    const { year, month, day } = getEasternParts(date);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Get the current hour key (YYYY-MM-DDTHH)
 */
function getHourKey(date = getCurrentEasternTime()) {
    const { year, month, day, hour } = getEasternParts(date);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}`;
}

/**
 * Get the current week key (YYYY-WNN) using ISO 8601 week numbering
 * ISO 8601: Week 1 is the week containing the first Thursday of the year
 */
function getWeekKey(date = getCurrentEasternTime()) {
    const { year, month, day } = getEasternParts(date);
    // Create date in UTC for consistent calculation
    const d = new Date(Date.UTC(year, month - 1, day));

    // ISO 8601: Week starts on Monday (day 1), Sunday is day 7
    // Set to nearest Thursday: current date + 4 - current day number (makes Sunday = 7)
    const dayNum = d.getUTCDay() || 7; // Convert Sunday from 0 to 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);

    // Get first day of the year for the Thursday's year (may differ from input year at boundaries)
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

    // Calculate week number: how many weeks between yearStart and the Thursday
    const weekNumber = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

    // Use the year of the Thursday (handles year boundary cases correctly)
    return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the current month key (YYYY-MM)
 */
function getMonthKey(date = getCurrentEasternTime()) {
    const { year, month } = getEasternParts(date);
    return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Count tokens using SillyTavern's native tokenizer (async, non-blocking)
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // Use async count exclusively to avoid blocking the main thread
        // getTextTokens() can make synchronous XMLHttpRequests which freeze the UI
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / 3.35);
    }
}

/**
 * Get the current model ID based on the active API
 * @returns {string} Model identifier
 */
function getCurrentModelId() {
    try {
        if (main_api === 'openai') {
            const model = getChatCompletionModel();
            return model || oai_settings?.custom_model || 'unknown-openai';
        }
        if (main_api === 'textgenerationwebui') {
            return textgen_settings?.model || 'unknown-textgen';
        }
        if (main_api === 'novel') {
            return 'novelai';
        }
        if (main_api === 'kobold') {
            return 'kobold';
        }
        return main_api || 'unknown';
    } catch (e) {
        console.warn('[Token Usage Tracker] Error getting model ID:', e);
        return 'unknown';
    }
}

/**
 * Get the current source ID (API type)
 * For OpenAI-compatible APIs, returns the specific chat_completion_source (e.g., 'openai', 'custom', 'windowai', etc.)
 * @returns {string} Source identifier
 */
function getCurrentSourceId() {
    // For OpenAI API, get the specific chat completion source (openai, custom, claude, etc.)
    if (main_api === 'openai' && oai_settings?.chat_completion_source) {
        return oai_settings.chat_completion_source;
    }
    return main_api || 'unknown';
}

// OpenRouter pricing cache duration (24 hours in ms)
const OPENROUTER_CACHE_DURATION = 24 * 60 * 60 * 1000;

/**
 * Fetch model pricing from OpenRouter's public API
 * Stores pricing in settings.openRouterPrices cache
 * @returns {Promise<boolean>} True if fetch was successful
 */
async function fetchOpenRouterPricing() {
    try {
        console.log('[Token Usage Tracker] Fetching OpenRouter model pricing...');

        const response = await fetch('https://openrouter.ai/api/v1/models');
        if (!response.ok) {
            console.warn('[Token Usage Tracker] OpenRouter API returned status:', response.status);
            return false;
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) {
            console.warn('[Token Usage Tracker] Unexpected OpenRouter API response format');
            return false;
        }

        const settings = getSettings();
        if (!settings.openRouterPrices) {
            settings.openRouterPrices = { data: {}, lastFetched: null };
        }

        // Parse and store pricing for each model
        const pricingData = {};
        for (const model of data.data) {
            if (model.id && model.pricing) {
                pricingData[model.id] = {
                    prompt: model.pricing.prompt || '0',
                    completion: model.pricing.completion || '0'
                };
            }
        }

        settings.openRouterPrices.data = pricingData;
        settings.openRouterPrices.lastFetched = Date.now();
        invalidateModelPriceCache();
        modelConfigState.needsRefresh = true;
        saveSettings();

        console.log(`[Token Usage Tracker] Cached pricing for ${Object.keys(pricingData).length} OpenRouter models`);
        return true;
    } catch (error) {
        console.warn('[Token Usage Tracker] Failed to fetch OpenRouter pricing:', error);
        return false;
    }
}

/**
 * Conditionally fetch OpenRouter pricing if:
 * 1. Current source is 'openrouter'
 * 2. Cache is empty or older than 24 hours
 * @returns {Promise<void>}
 */
/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function invalidateModelPriceCache(modelId = null) {
    if (modelId) {
        modelPriceCache.delete(modelId);
        return;
    }
    modelPriceCache.clear();
}

async function maybeAutoFetchOpenRouterPricing() {
    const currentSource = getCurrentSourceId();

    // Only fetch if using OpenRouter
    if (currentSource !== 'openrouter') {
        return;
    }

    const settings = getSettings();
    const lastFetched = settings.openRouterPrices?.lastFetched;
    const now = Date.now();

    // Check if cache is stale (>24 hours old) or empty
    if (!lastFetched || (now - lastFetched) > OPENROUTER_CACHE_DURATION) {
        await fetchOpenRouterPricing();
    }
}

/**
 * Add tokens and generation counters to every usage bucket for one generation or attempt
 * @param {{input: number, output: number, reasoning: number}} tokens
 * @param {{messageCount?: number, stopped?: number, failed?: number}} counts
 * @param {string|null} chatId
 * @param {string|null} modelId
 * @param {string|null} sourceId
 */
function addToUsageBuckets(tokens, counts, chatId, modelId, sourceId) {
    const usage = getSettings().usage;
    const now = getCurrentEasternTime();
    const { input, output, reasoning } = tokens;
    const total = input + output + reasoning;

    // Top-level buckets track reasoning separately
    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + input;
        bucket.output = (bucket.output || 0) + output;
        bucket.reasoning = (bucket.reasoning || 0) + reasoning;
        bucket.total = (bucket.total || 0) + total;
        bumpCounts(bucket, counts);
    };

    // Nested model/source entries (used for cost, stacking and filtering) have no reasoning field
    const addNested = (parent, key, id, create = () => ({ input: 0, output: 0, total: 0 })) => {
        if (!parent[key]) parent[key] = {};
        if (!parent[key][id]) parent[key][id] = create();
        const entry = parent[key][id];
        entry.input = (entry.input || 0) + input;
        entry.output = (entry.output || 0) + output;
        entry.total = (entry.total || 0) + total;
        bumpCounts(entry, counts);
        return entry;
    };

    // Session (with models for accurate cost calculation)
    addTokens(usage.session);
    if (modelId) addNested(usage.session, 'models', modelId);

    // All-time
    addTokens(usage.allTime);

    // By day, with models for the stacked chart and sources (and their models) for filtering
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {}, sources: {} };
    const dayData = usage.byDay[dayKey];
    addTokens(dayData);
    if (modelId) addNested(dayData, 'models', modelId);
    if (sourceId) {
        const sourceData = addNested(dayData, 'sources', sourceId, () => ({ input: 0, output: 0, total: 0, models: {} }));
        if (modelId) addNested(sourceData, 'models', modelId);
    }

    // By hour
    const hourKey = getHourKey(now);
    if (!usage.byHour[hourKey]) usage.byHour[hourKey] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {}, sources: {} };
    const hourData = usage.byHour[hourKey];
    addTokens(hourData);
    if (modelId) addNested(hourData, 'models', modelId);
    if (sourceId) addNested(hourData, 'sources', sourceId);

    // By week
    const weekKey = getWeekKey(now);
    if (!usage.byWeek[weekKey]) usage.byWeek[weekKey] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 };
    addTokens(usage.byWeek[weekKey]);

    // By month
    const monthKey = getMonthKey(now);
    if (!usage.byMonth[monthKey]) usage.byMonth[monthKey] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 };
    addTokens(usage.byMonth[monthKey]);

    // By chat (with models for cost calculation)
    if (chatId) {
        if (!usage.byChat[chatId]) usage.byChat[chatId] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {} };
        addTokens(usage.byChat[chatId]);
        if (modelId) addNested(usage.byChat[chatId], 'models', modelId);
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    // By source (aggregate)
    if (sourceId) {
        if (!usage.bySource[sourceId]) usage.bySource[sourceId] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0 };
        addTokens(usage.bySource[sourceId]);
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response (excluding reasoning)
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 * @param {string} [sourceId] - Optional source ID for per-source tracking
 * @param {number} [reasoningTokens] - Optional reasoning/thinking tokens (Claude, o1, etc.)
 * @param {'succeeded'|'stopped'} [outcome] - 'stopped' also counts the generation as stopped
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null, sourceId = null, reasoningTokens = 0, outcome = 'succeeded') {
    const stopped = outcome === 'stopped' ? 1 : 0;
    addToUsageBuckets(
        { input: inputTokens, output: outputTokens, reasoning: reasoningTokens },
        { messageCount: 1, stopped },
        chatId, modelId, sourceId,
    );

    saveSettings();

    // Update health tracking timestamp
    lastRecordedTimestamp = getCurrentEasternTime().toISOString();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    console.log(`[Token Usage Tracker] Recorded${stopped ? ' stopped generation' : ''}: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'}, source: ${sourceId || 'unknown'} (using ${getFriendlyTokenizerName(main_api).tokenizerName})`);
}

/**
 * Record a generation attempt that failed before producing a result (no tokens counted)
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 * @param {string} [sourceId] - Optional source ID for per-source tracking
 */
function recordFailedAttempt(chatId = null, modelId = null, sourceId = null) {
    addToUsageBuckets({ input: 0, output: 0, reasoning: 0 }, { failed: 1 }, chatId, modelId, sourceId);
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log(`[Token Usage Tracker] Recorded failed generation attempt, model: ${modelId || 'unknown'}, source: ${sourceId || 'unknown'}`);
}

/**
 * Reset session usage
 */
function resetSession() {
    const settings = getSettings();
    settings.usage.session = {
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
        messageCount: 0,
        models: {},
        startTime: getCurrentEasternTime().toISOString(),
    };
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] Session reset');
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    const settings = getSettings();
    settings.usage = structuredClone(defaultSettings.usage);
    settings.usage.session.startTime = getCurrentEasternTime().toISOString();
    settings.usage.outcomesTrackedSince = settings.usage.session.startTime;
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const settings = getSettings();
    const usage = settings.usage;
    const now = getCurrentEasternTime();

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    return {
        session: { ...usage.session },
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0, models: {} },
        thisHour: usage.byHour[getHourKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisWeek: usage.byWeek[getWeekKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisMonth: usage.byMonth[getMonthKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
        byHour: { ...usage.byHour },
        byWeek: { ...usage.byWeek },
        byMonth: { ...usage.byMonth },
        byChat: { ...usage.byChat },
        byModel: { ...usage.byModel },
    };
}

/**
 * Get usage for a specific time range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object} Aggregated usage for the range
 */
function getUsageForRange(startDate, endDate) {
    const settings = getSettings();
    const usage = settings.usage;

    const result = { input: 0, output: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Bucket keys for the day and hour in which stopped/failed tracking began
 * @returns {{day: string|null, hour: string|null, since: Date|null}}
 */
function getOutcomeTrackingKeys() {
    const since = new Date(getSettings().usage.outcomesTrackedSince || NaN);
    if (Number.isNaN(since.getTime())) return { day: null, hour: null, since: null };
    return { day: getDayKey(since), hour: getHourKey(since), since };
}

/**
 * Format a success rate, or '—' when the period predates outcome tracking
 * @param {{successRate: number|null}} stats - From generationStats()
 * @param {boolean} complete - Whether the period has complete outcome data
 * @returns {string}
 */
function formatSuccessRate(stats, complete) {
    return complete && stats.successRate !== null ? `${(stats.successRate * 100).toFixed(1)}%` : '—';
}

/**
 * Get usage for a specific chat
 * @param {string} chatId - Chat ID
 * @returns {Object} Usage for the chat
 */
function getChatUsage(chatId) {
    const settings = getSettings();
    return settings.usage.byChat[chatId] || { input: 0, output: 0, total: 0, messageCount: 0 };
}

function getCurrentChatId() {
    const context = getContext();
    return context?.chatMetadata?.chat_id
        ?? context?.chatMetadata?.chatId
        ?? context?.chat_id
        ?? context?.chatId
        ?? context?.currentChatId
        ?? null;
}

/** Generation type and continue snapshot from the latest GENERATION_STARTED, consumed by GENERATE_AFTER_DATA */
let pendingGenerationStart = null;
/** Tracks each generation attempt from request to outcome (succeeded / stopped / failed) */
const attemptTracker = createAttemptTracker({ onResolve: handleAttemptResolved });

/**
 * Count input tokens from the full prompt context (async helper)
 * @param {object} generate_data - The generation data containing the full prompt
 * @returns {Promise<number>} Total input token count
 */
async function countInputTokens(generate_data) {
    let inputTokens = 0;

    if (generate_data.prompt) {
        // For text completion APIs (kobold, novel, textgen) - prompt is a string
        if (typeof generate_data.prompt === 'string') {
            inputTokens = await countTokens(generate_data.prompt);
        }
        // For chat completion APIs (OpenAI) - prompt is an array of messages
        else if (Array.isArray(generate_data.prompt)) {
            for (const message of generate_data.prompt) {
                if (message.content) {
                    // Content can be a string or an array of content parts (for multimodal)
                    if (typeof message.content === 'string') {
                        inputTokens += await countTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        // Handle multimodal content (text + images)
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                inputTokens += await countTokens(part.text);
                            }
                            if (part.type === 'image_url' || part.type === 'image') {
                                // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                                // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                                inputTokens += 765;
                            }
                        }
                    }
                }
                // Count role tokens (~1 token per role)
                if (message.role) {
                    inputTokens += 1;
                }
                // Count name field tokens (used in function calls, tool results, etc.)
                if (message.name) {
                    inputTokens += await countTokens(message.name);
                }
                // Count tool_calls tokens (Standard OpenAI)
                if (Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                inputTokens += await countTokens(toolCall.function.name);
                            }
                            if (toolCall.function.arguments) {
                                inputTokens += await countTokens(toolCall.function.arguments);
                            }
                        }
                    }
                }
                // Count invocations tokens (SillyTavern internal)
                if (Array.isArray(message.invocations)) {
                    for (const invocation of message.invocations) {
                        if (invocation.function) {
                            if (invocation.function.name) {
                                inputTokens += await countTokens(invocation.function.name);
                            }
                            if (invocation.function.arguments) {
                                inputTokens += await countTokens(invocation.function.arguments);
                            }
                        }
                    }
                }
                // Count deprecated function_call tokens
                if (message.function_call) {
                    if (message.function_call.name) {
                        inputTokens += await countTokens(message.function_call.name);
                    }
                    if (message.function_call.arguments) {
                        inputTokens += await countTokens(message.function_call.arguments);
                    }
                }
            }
            // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
            inputTokens += generate_data.prompt.length * 3;
        }
    }

    return inputTokens;
}

/**
 * Handle GENERATION_STARTED event - remember the generation type and, for 'continue',
 * snapshot the current message's token count so only the delta is counted later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Check if we need to fetch OpenRouter pricing (fire and forget)
    maybeAutoFetchOpenRouterPricing();

    let preContinuePromise = null;
    if (type === 'continue') {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available (fast path)
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    preContinuePromise = Promise.resolve(lastMessage.extra.token_count);
                } else {
                    preContinuePromise = (async () => {
                        try {
                            let tokens = await countTokens(lastMessage.mes || '');
                            if (lastMessage.extra?.reasoning) {
                                tokens += await countTokens(lastMessage.extra.reasoning);
                            }
                            return tokens;
                        } catch (error) {
                            console.error('[Token Usage Tracker] Error calculating pre-continue tokens:', error);
                            return 0;
                        }
                    })();
                }
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            preContinuePromise = Promise.resolve(0);
        }
    }

    pendingGenerationStart = { type, preContinuePromise };
}

/**
 * Handle GENERATE_AFTER_DATA event - begin a generation attempt and start counting
 * input tokens (non-blocking, runs in parallel with the API request)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    const start = pendingGenerationStart;
    pendingGenerationStart = null;
    const genType = start?.type || 'normal';
    const kind = genType === 'quiet' ? 'quiet' : 'main';
    const modelId = getCurrentModelId();
    const sourceId = getCurrentSourceId();

    const inputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${modelId}, source: ${sourceId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });

    attemptTracker.begin(kind, {
        genType,
        modelId,
        sourceId,
        // Quiet generations are not attributed to a chat
        chatId: kind === 'quiet' ? null : getCurrentChatId(),
        inputTokensPromise,
        preContinuePromise: start?.preContinuePromise || null,
    });
}

/**
 * Handle message received event - the open main generation succeeded
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    const nonApiTypes = ['command', 'first_message'];
    if (nonApiTypes.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // Claim synchronously so the generation-ended check cannot mark it failed
    const attempt = attemptTracker.openMain();
    if (!attempt || attempt.meta.genType === 'impersonate') {
        console.log(`[Token Usage Tracker] Skipping message with no pending generation (type: ${type || 'unknown'})`);
        return;
    }

    const message = getContext().chat?.[messageIndex] || null;
    attemptTracker.resolve(attempt, 'succeeded', { message, type });
}

/**
 * Handle impersonate ready event - the impersonation succeeded
 * @param {string} text - The generated impersonation text
 */
function handleImpersonateReady(text) {
    const attempt = attemptTracker.openMain();
    if (!attempt) return;
    attemptTracker.resolve(attempt, 'succeeded', { text: typeof text === 'string' ? text : '' });
}

/**
 * Handle generation stopped event - count input and any partial output of the stopped generation.
 * Quiet generations are resolved by their aborted request instead.
 */
function handleGenerationStopped() {
    const attempt = attemptTracker.openMain();
    if (!attempt) return;

    // Capture partial output now, before the next generation replaces the processor
    const sp = attempt.meta.streamingProcessor
        || (streamingProcessor && !streamingProcessor.isStopped ? streamingProcessor : null);
    attemptTracker.resolve(attempt, 'stopped', {
        text: sp?.result || '',
        reasoning: sp?.reasoningHandler?.reasoning || '',
    });
}

/**
 * Handle generation ended event (fires when the stop button hides: on success, error and stop)
 */
function handleGenerationEnded() {
    const attempt = attemptTracker.openMain();
    // A live, non-errored processor means this generation streamed even if its request did not say so.
    // (SillyTavern clears the processor after every stream except one that errored.)
    if (attempt && !attempt.meta.streamingProcessor && streamingProcessor && !streamingProcessor.isStopped) {
        attempt.meta.streamingProcessor = streamingProcessor;
        attemptTracker.markStreaming(attempt);
    }
    const sp = attempt?.meta.streamingProcessor;
    // onErrorStreaming sets isStopped; a user stop sets isFinished instead
    const streamError = Boolean(sp && sp.isStopped === true && sp.isFinished !== true);
    attemptTracker.generationEnded({ streamError });
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Open attempts are kept: they are real requests and carry their own chat ID
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit('tokenUsageUpdated', getUsageStats());
}

/**
 * Record a resolved generation attempt (called synchronously by the attempt tracker)
 * @param {object} attempt
 * @param {'succeeded'|'stopped'|'failed'} status
 * @param {object} details
 */
function handleAttemptResolved(attempt, status, details) {
    attempt.recording = recordAttempt(attempt, status, details).catch(error => {
        console.error('[Token Usage Tracker] Error recording generation:', error);
        recordHealthError(error?.message || String(error));
    });
}

/**
 * Count tokens for a resolved attempt and record it
 * @param {object} attempt
 * @param {'succeeded'|'stopped'|'failed'} status
 * @param {object} details - { message } | { text, reasoning } | { responseData } | {}
 */
async function recordAttempt(attempt, status, details) {
    const { chatId, modelId, sourceId } = attempt.meta;

    if (status === 'failed') {
        recordFailedAttempt(chatId, modelId, sourceId);
        return;
    }

    let outputTokens = 0;
    let reasoningTokens = 0;

    if (details.message) {
        ({ outputTokens, reasoningTokens } = await countMessageOutput(details.message, attempt));
    } else {
        let text = details.text || '';
        let reasoning = details.reasoning || '';
        if (details.responseData) {
            text = extractResponseText(details.responseData);
            reasoning = await extractResponseReasoning(details.responseData);
        }
        if (text) outputTokens = await countTokens(text);
        if (reasoning) reasoningTokens = await countTokens(reasoning);
    }

    const inputTokens = (await attempt.meta.inputTokensPromise) || 0;
    recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, reasoningTokens, status === 'stopped' ? 'stopped' : 'succeeded');
}

/**
 * Count output tokens of a received chat message.
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning),
 * falling back to manual counting.
 * @param {object} message - Chat message
 * @param {object} attempt - The generation attempt that produced it
 * @returns {Promise<{outputTokens: number, reasoningTokens: number}>}
 */
async function countMessageOutput(message, attempt) {
    let outputTokens;
    let reasoningTokens = 0;

    // Count reasoning/thinking tokens separately (from Claude thinking, OpenAI o1, etc.)
    if (message.extra?.reasoning) {
        reasoningTokens = await countTokens(message.extra.reasoning);
    }

    // token_count may include reasoning tokens, so subtract them to get just response tokens
    if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
        outputTokens = message.extra.token_count;
        if (reasoningTokens > 0 && message.extra.token_count > reasoningTokens) {
            outputTokens = message.extra.token_count - reasoningTokens;
        }
    } else {
        outputTokens = await countTokens(message.mes || '');
    }

    // For 'continue', only count the newly generated tokens
    if (attempt.meta.genType === 'continue' && attempt.meta.preContinuePromise) {
        const preContinueTokenCount = await attempt.meta.preContinuePromise;
        if (preContinueTokenCount > 0) {
            const fullOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${fullOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }
    }

    return { outputTokens, reasoningTokens };
}

/**
 * Extract the generated text from a non-streaming API response
 * @param {object} data - Response JSON
 * @returns {string}
 */
function extractResponseText(data) {
    try {
        const text = stScript.extractMessageFromData?.(data);
        return typeof text === 'string' ? text : '';
    } catch {
        return '';
    }
}

/** @type {Promise<object|null>|null} */
let reasoningModulePromise = null;

/**
 * Extract reasoning from a non-streaming API response (best effort)
 * @param {object} data - Response JSON
 * @returns {Promise<string>}
 */
async function extractResponseReasoning(data) {
    reasoningModulePromise ??= import('../../../reasoning.js').catch(() => null);
    const reasoningModule = await reasoningModulePromise;
    try {
        const reasoning = reasoningModule?.extractReasoningFromData?.(data, { ignoreShowThoughts: true });
        return typeof reasoning === 'string' ? reasoning : '';
    } catch {
        return '';
    }
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenusage',
        callback: async () => {
            const stats = getUsageStats();
            const output = [
                `Tokenizer: ${stats.tokenizer}`,
                `Session: ${stats.session.total} tokens (${stats.session.input} in, ${stats.session.output} out)`,
                `Today: ${stats.today.total} tokens`,
                `This Week: ${stats.thisWeek.total} tokens`,
                `This Month: ${stats.thisMonth.total} tokens`,
                `All Time: ${stats.allTime.total} tokens`,
            ].join('\n');
            return output;
        },
        returns: 'Token usage statistics',
        helpString: 'Displays current token usage statistics across different time periods.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenreset',
        callback: async (args) => {
            const scope = String(args || '').trim() || 'session';
            if (scope === 'all') {
                resetAllUsage();
                return 'All token usage data has been reset.';
            } else {
                resetSession();
                return 'Session token usage has been reset.';
            }
        },
        returns: 'Confirmation message',
        helpString: 'Resets token usage. Use /tokenreset for session only, or /tokenreset all for all data.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokencost',
        callback: async () => {
            const settings = getSettings();
            const byModel = settings.usage.byModel;
            const lines = ['**Cost Breakdown by Model:**'];
            let totalCost = 0;

            for (const [modelId, data] of Object.entries(byModel)) {
                const cost = calculateCost(data.input, data.output, modelId);
                totalCost += cost;
                if (cost > 0) {
                    lines.push(`• ${modelId}: $${cost.toFixed(4)} (${formatNumberFull(data.input)} in, ${formatNumberFull(data.output)} out)`);
                }
            }

            if (lines.length === 1) {
                return 'No cost data available. Configure model prices in the Token Usage Tracker settings.';
            }

            lines.push(`**Total: $${totalCost.toFixed(2)}**`);
            return lines.join('\n');
        },
        returns: 'Cost breakdown by model',
        helpString: 'Displays estimated cost breakdown by model. Configure prices in extension settings.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokentoday',
        callback: async () => {
            const stats = getUsageStats();
            const efficiency = calculateEfficiencyMetrics(stats.today);
            const now = getCurrentEasternTime();
            const tracking = getOutcomeTrackingKeys();
            const today = generationStats(stats.today);
            const hour = generationStats(stats.thisHour);
            const todayComplete = hasCompleteOutcomes(getDayKey(now), tracking.day);
            const hourComplete = hasCompleteOutcomes(getHourKey(now), tracking.hour);
            const trackingNote = !todayComplete && tracking.since ? ` (tracking began ${_fmtHourFull.format(tracking.since)})` : '';
            return [
                `**Today's Token Usage:**`,
                `Total: ${formatNumberFull(stats.today.total)} tokens`,
                `Input: ${formatNumberFull(stats.today.input || 0)} tokens`,
                `Output: ${formatNumberFull(stats.today.output || 0)} tokens`,
                `Generations: ${formatNumberFull(today.generations)}`,
                `Stopped: ${formatNumberFull(today.stopped)}`,
                `Failed: ${formatNumberFull(today.failed)}`,
                `Success rate: ${formatSuccessRate(today, todayComplete)}${trackingNote}`,
                `This hour: ${hour.generations} generations, ${hour.stopped} stopped, ${hour.failed} failed, ${formatSuccessRate(hour, hourComplete)} success`,
                `Efficiency: ${efficiency.ratio.toFixed(2)}× out/in, ${formatTokens(efficiency.perMessage)}/gen`,
            ].join('\n');
        },
        returns: "Today's token usage",
        helpString: "Displays today's token usage with efficiency metrics.",
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenchat',
        callback: async () => {
            const chatId = getCurrentChatId();

            if (!chatId) {
                return 'No active chat found.';
            }

            const chatUsage = getChatUsage(chatId);
            const efficiency = calculateEfficiencyMetrics(chatUsage);

            return [
                `**Current Chat Usage:**`,
                `Chat ID: ${chatId}`,
                `Total: ${formatNumberFull(chatUsage.total)} tokens`,
                `Input: ${formatNumberFull(chatUsage.input)} tokens`,
                `Output: ${formatNumberFull(chatUsage.output)} tokens`,
                `Generations: ${formatNumberFull(chatUsage.messageCount || 0)}`,
                `Stopped: ${formatNumberFull(chatUsage.stopped || 0)} · Failed: ${formatNumberFull(chatUsage.failed || 0)}`,
                `Efficiency: ${efficiency.ratio.toFixed(2)}× out/in, ${formatTokens(efficiency.perMessage)}/gen`,
            ].join('\n');
        },
        returns: 'Current chat token usage',
        helpString: 'Displays token usage for the current chat.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenexport',
        callback: async () => {
            const exportData = exportUsageData();

            // Create and trigger download
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `token-usage-export-${getDayKey()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            return 'Token usage data exported successfully.';
        },
        returns: 'Export confirmation',
        helpString: 'Exports all token usage data as a JSON file.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenimport',
        callback: async (args, value) => {
            if (!value || !value.trim()) {
                return 'Usage: /tokenimport [json data] or paste JSON directly. Use /tokenexport first to get the format.';
            }

            try {
                const result = importUsageData(value.trim());
                return result.message;
            } catch (error) {
                return `Import failed: ${error.message}`;
            }
        },
        returns: 'Import result',
        helpString: 'Imports token usage data from JSON. Use /tokenexport to see the expected format.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'JSON data to import',
                typeList: ['string'],
                isRequired: true,
            }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenmini',
        callback: () => {
            toggleMiniview();
            const settings = getSettings();
            const isVisible = miniviewElement && $(miniviewElement).is(':visible');
            return isVisible ? 'Miniview shown.' : 'Miniview hidden.';
        },
        returns: 'Miniview toggle status',
        helpString: 'Toggles the compact miniview panel showing session/hourly/daily token usage.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenerrors',
        callback: async (_args, value) => {
            if (String(value ?? '').trim().toLowerCase() === 'clear') {
                clearErrorTracking();
                return 'API errors cleared.';
            }

            const routes = erroringRoutes(getSettings().errorTracking);
            if (!routes.length) {
                return 'No API errors recorded.';
            }

            const lines = ['**API errors by route:**'];
            for (const route of routes) {
                const breakdown = errorBreakdown(route).map(([name, count]) => `${name} ×${count}`).join(', ');
                const last = route.lastError ? ` Last (${formatErrorTime(route.lastError.at)}): ${route.lastError.message}` : '';
                lines.push(`• ${route.model} (${formatRouteWhere(route)}): ${route.errors} of ${route.attempts} failed (${formatErrorRate(route.errorRate)}), ${breakdown}.${last}`);
            }
            return lines.join('\n');
        },
        returns: 'API errors by source, endpoint, model and provider',
        helpString: 'Lists API errors by route: source, endpoint host, model and provider. Use /tokenerrors clear to clear them.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: '"clear" to clear recorded errors',
                typeList: ['string'],
                isRequired: false,
                enumList: ['clear'],
            }),
        ],
    }));
}

/**
 * Public API exposed for frontend/UI components
 */
window['TokenUsageTracker'] = {
    getStats: getUsageStats,
    getUsageForRange,
    getChatUsage,
    resetSession,
    resetAllUsage,
    recordUsage,
    recordFailedAttempt,
    countTokens, // Expose the token counting function
    getCurrentModelId,
    getCurrentSourceId,
    flushPendingQuietGeneration,
    // API errors by route (source, endpoint host, model, provider), most errors first
    getErrorRoutes: () => erroringRoutes(getSettings().errorTracking),
    // Recent API errors, oldest first
    getErrorLog: () => [...getSettings().errorTracking.log],
    clearErrors: clearErrorTracking,
    // Subscribe to updates
    onUpdate: (callback) => {
        eventSource.on('tokenUsageUpdated', callback);
    },
    // Unsubscribe from updates
    offUpdate: (callback) => {
        eventSource.removeListener('tokenUsageUpdated', callback);
    },
};

/**
 * Format token count with K/M suffix
 */
function formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

/**
 * Format a count: exact below 10,000, abbreviated above
 */
function formatCount(count) {
    return count >= 10000 ? formatTokens(count) : formatNumberFull(count);
}

/**
 * Format number with commas
 */
function formatNumberFull(num) {
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Generate a random color using HSL for guaranteed distinctness
 * Colors are persisted once assigned to maintain consistency
 * @param {string} modelId - Model identifier
 * @returns {string} Hex color code
 */
function getModelColor(modelId) {
    const settings = getSettings();

    // Return persisted color if exists
    if (settings.modelColors[modelId]) {
        return settings.modelColors[modelId];
    }

    // Get all existing assigned colors to avoid duplicates
    const existingColors = Object.values(settings.modelColors);

    // Generate a random color that's distinct from existing ones
    let newColor;
    let attempts = 0;
    do {
        // Random hue (0-360), high saturation (60-80%), medium lightness (45-65%)
        const hue = Math.floor(Math.random() * 360);
        const sat = 60 + Math.floor(Math.random() * 20);
        const light = 45 + Math.floor(Math.random() * 20);
        newColor = hslToHex(hue, sat, light);
        attempts++;
    } while (attempts < 50 && isTooSimilar(newColor, existingColors));

    // Persist the new color
    settings.modelColors[modelId] = newColor;
    saveSettings();

    return newColor;
}

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Check if a color is too similar to any existing colors
 */
function isTooSimilar(newColor, existingColors) {
    for (const existing of existingColors) {
        if (colorDistance(newColor, existing) < 50) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate color distance (simple RGB euclidean)
 */
function colorDistance(c1, c2) {
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Set color for a model
 * @param {string} modelId - Model identifier
 * @param {string} color - Hex color code
 */
function setModelColor(modelId, color) {
    const settings = getSettings();
    settings.modelColors[modelId] = color;
    saveSettings();
}

/**
 * Get price settings for a model
 * Priority: model override, shared group, OpenRouter exact/suffix, default zeros.
 * @param {string} modelId
 * @returns {{in: number, out: number}} Price per 1M tokens
 */
function getModelPrice(modelId) {
    const cacheKey = String(modelId || '');
    const cached = modelPriceCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const settings = getSettings();

    const configured = configuredPrice(settings, cacheKey);
    if (configured) {
        const userPrice = configured.price;
        const resolved = {
            in: parseFloat(userPrice?.in) || 0,
            out: parseFloat(userPrice?.out) || 0
        };
        modelPriceCache.set(cacheKey, resolved);
        return resolved;
    }

    // Auto-populated from OpenRouter cache - try exact match first
    const orPrice = settings.openRouterPrices?.data?.[cacheKey];
    if (orPrice) {
        // OpenRouter returns price per token, convert to per 1M tokens
        const resolved = {
            in: (parseFloat(orPrice.prompt) || 0) * 1000000,
            out: (parseFloat(orPrice.completion) || 0) * 1000000
        };
        modelPriceCache.set(cacheKey, resolved);
        return resolved;
    }

    // Fallback: Check if the end of modelId matches any key in OpenRouter price data (case-insensitive)
    if (settings.openRouterPrices?.data) {
        const modelIdLower = cacheKey.toLowerCase();

        // Find the longest matching suffix to prefer more specific matches
        let bestMatch = null;
        let bestMatchLength = 0;

        for (const priceKey of Object.keys(settings.openRouterPrices.data)) {
            const priceKeyLower = priceKey.toLowerCase();

            // Check if modelId ends with this price key
            if (modelIdLower.endsWith(priceKeyLower) && priceKeyLower.length > bestMatchLength) {
                bestMatch = priceKey;
                bestMatchLength = priceKeyLower.length;
            }
        }

        if (bestMatch) {
            const matchedPrice = settings.openRouterPrices.data[bestMatch];
            console.log(`[Token Usage Tracker] Model "${cacheKey}" matched to OpenRouter pricing for "${bestMatch}" via suffix match`);
            const resolved = {
                in: (parseFloat(matchedPrice.prompt) || 0) * 1000000,
                out: (parseFloat(matchedPrice.completion) || 0) * 1000000
            };
            modelPriceCache.set(cacheKey, resolved);
            return resolved;
        }
    }

    const resolved = { in: 0, out: 0 };
    modelPriceCache.set(cacheKey, resolved);
    return resolved;
}

/**
 * Calculate cost for a given token usage and model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens, modelId) {
    const prices = getModelPrice(modelId);
    if (!prices.in && !prices.out) return 0;

    const inputCost = (inputTokens / 1000000) * prices.in;
    const outputCost = (outputTokens / 1000000) * prices.out;
    return inputCost + outputCost;
}

/**
 * Calculate all-time cost using the byModel aggregation which has precise input/output counts
 */
function calculateAllTimeCost() {
    const settings = getSettings();
    const byModel = settings.usage.byModel;
    let totalCost = 0;

    for (const [modelId, data] of Object.entries(byModel)) {
        totalCost += calculateCost(data.input, data.output, modelId);
    }
    return totalCost;
}

/**
 * Calculate token efficiency metrics
 * @param {Object} data - Usage data with input, output, total, and messageCount
 * @returns {Object} Efficiency metrics
 */
function calculateEfficiencyMetrics(data) {
    const ratio = data.input > 0 ? (data.output / data.input) : 0;
    const perMessage = data.messageCount > 0
        ? Math.round(data.total / data.messageCount)
        : 0;
    return { ratio, perMessage };
}

/**
 * Export all usage data for backup
 * @returns {Object} Export data object
 */
function exportUsageData() {
    const settings = getSettings();
    return {
        version: '1.1',
        exportDate: getCurrentEasternTime().toISOString(),
        extensionName: extensionName,
        usage: settings.usage,
        modelPrices: settings.modelPrices,
        sharedModelPrices: settings.sharedModelPrices,
        modelPriceGroups: settings.modelPriceGroups,
        modelColors: settings.modelColors,
        errorTracking: settings.errorTracking,
    };
}

/**
 * Import usage data from JSON
 * @param {string} jsonString - JSON string to import
 * @returns {Object} Result object with success status and message
 */
function importUsageData(jsonString) {
    let data;
    try {
        data = JSON.parse(jsonString);
    } catch (e) {
        throw new Error('Invalid JSON format');
    }

    // Validate structure
    if (!data.version || !data.usage) {
        throw new Error('Invalid export format. Missing required fields.');
    }

    if (data.extensionName && data.extensionName !== extensionName) {
        throw new Error(`Data was exported from a different extension: ${data.extensionName}`);
    }

    // Validate before changing usage or settings. Restore complete pricing state
    // so removed overrides cannot reappear when importing a new-format backup.
    const pricingSnapshot = readPricingSnapshot(data);

    const settings = getSettings();

    // Import usage data (replace, not merge, to avoid doubling stats)
    if (data.usage.session) {
        // Don't import session data - it's ephemeral
    }

    // Replace byDay data (overwrite existing days to prevent doubling)
    if (data.usage.byDay) {
        for (const [dayKey, dayData] of Object.entries(data.usage.byDay)) {
            settings.usage.byDay[dayKey] = dayData;
        }
    }

    // Replace byHour data (overwrite existing hours to prevent doubling)
    if (data.usage.byHour) {
        for (const [hourKey, hourData] of Object.entries(data.usage.byHour)) {
            settings.usage.byHour[hourKey] = hourData;
        }
    }

    // Replace byWeek data
    if (data.usage.byWeek) {
        for (const [weekKey, weekData] of Object.entries(data.usage.byWeek)) {
            settings.usage.byWeek[weekKey] = weekData;
        }
    }

    // Replace byMonth data
    if (data.usage.byMonth) {
        for (const [monthKey, monthData] of Object.entries(data.usage.byMonth)) {
            settings.usage.byMonth[monthKey] = monthData;
        }
    }

    // Replace byChat data
    if (data.usage.byChat) {
        for (const [chatId, chatData] of Object.entries(data.usage.byChat)) {
            settings.usage.byChat[chatId] = chatData;
        }
    }

    // Replace byModel data
    if (data.usage.byModel) {
        for (const [modelId, modelData] of Object.entries(data.usage.byModel)) {
            settings.usage.byModel[modelId] = modelData;
        }
    }

    // Replace bySource data
    if (data.usage.bySource) {
        for (const [sourceId, sourceData] of Object.entries(data.usage.bySource)) {
            settings.usage.bySource[sourceId] = sourceData;
        }
    }

    // Replace allTime data
    if (data.usage.allTime) {
        settings.usage.allTime = data.usage.allTime;
    }

    // Replace model prices (overwrite existing)
    if (pricingSnapshot) {
        Object.assign(settings, pricingSnapshot);
        invalidateModelPriceCache();
        modelConfigState.needsRefresh = true;
    } else if (data.modelPrices) {
        settings.modelPrices = { ...settings.modelPrices, ...data.modelPrices };
        invalidateModelPriceCache();
        modelConfigState.needsRefresh = true;
    }
    modelConfigPriceDrafts.clear();

    // Replace model colors (overwrite existing)
    if (data.modelColors) {
        Object.assign(settings.modelColors, data.modelColors);
    }

    // Replace API errors when the export has them
    if (data.errorTracking) {
        settings.errorTracking = normalizeErrorStore(data.errorTracking);
    }

    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    renderErrorPanel();

    return {
        success: true,
        message: `Import successful. Replaced data from ${data.exportDate || 'unknown date'}.`
    };
}

// Chart state
let currentChartRange = 30;
let currentSourceFilter = 'all'; // 'all' or specific source ID like 'openai', 'textgenerationwebui'
let currentChartType = 'bar'; // 'bar' or 'line'
let currentGranularity = 'daily'; // 'daily' or 'hourly'
let currentChartMetric = 'tokens'; // 'tokens' or 'generations'
let chartData = [];
let tooltip = null;

const MODEL_CONFIG_PAGE_SIZE = 50;
const MODEL_CONFIG_SEARCH_DEBOUNCE_MS = 120;

const modelConfigState = {
    query: '',
    page: 1,
    pageSize: MODEL_CONFIG_PAGE_SIZE,
    isOpen: false,
    needsRefresh: true,
    lastModelCount: -1,
    lastRenderedSignature: '',
    lastRenderedPage: 1,
    lastRenderedQuery: '',
};

const modelPriceCache = new Map();
const modelConfigPriceDrafts = new Map();
const expandedPriceGroups = new Set();
let modelConfigSearchTimer = null;
let modelConfigRenderRaf = null;
let modelConfigPendingStats = null;
let modelConfigPendingForce = false;
let modelConfigVisibilityObserver = null;

// Miniview state
let miniviewElement = null;

// Health check state
let lastRecordedTimestamp = null;
let lastErrorTimestamp = null;
let lastErrorMessage = null;

/**
 * Get health status of the extension
 * @returns {Object} Health status object with status, lastActivity, and details
 */
function getHealthStatus() {
    const tokenizerAvailable = typeof getTokenCountAsync === 'function';
    const hasRecordedActivity = lastRecordedTimestamp !== null;

    let timeSinceActivity = null;
    if (lastRecordedTimestamp) {
        const elapsed = getCurrentEasternTime().getTime() - new Date(lastRecordedTimestamp).getTime();
        if (elapsed < 60000) {
            timeSinceActivity = Math.round(elapsed / 1000) + 's ago';
        } else if (elapsed < 3600000) {
            timeSinceActivity = Math.round(elapsed / 60000) + 'm ago';
        } else if (elapsed < 86400000) {
            timeSinceActivity = Math.round(elapsed / 3600000) + 'h ago';
        } else {
            timeSinceActivity = Math.round(elapsed / 86400000) + 'd ago';
        }
    }

    const hasRecentError = lastErrorTimestamp &&
        (getCurrentEasternTime().getTime() - new Date(lastErrorTimestamp).getTime() < 300000); // Error within last 5 min

    let status = 'healthy';
    if (hasRecentError) {
        status = 'warning';
    } else if (!tokenizerAvailable) {
        status = 'error';
    }

    return {
        status,
        lastActivity: timeSinceActivity,
        details: {
            tokenizerAvailable,
            hasRecordedActivity,
            lastError: hasRecentError ? lastErrorMessage : null
        }
    };
}

/**
 * Record an error for health tracking
 * @param {string} message - Error message
 */
function recordHealthError(message) {
    lastErrorTimestamp = getCurrentEasternTime().toISOString();
    lastErrorMessage = message;
}

// Chart colors - adapted for dark theme
const CHART_COLORS = {
    bar: 'var(--SmartThemeBorderColor)',
    text: 'var(--SmartThemeBodyColor)',
    grid: 'var(--SmartThemeBorderColor)',
    cursor: 'var(--SmartThemeBodyColor)'
};

const SVG_NS = "http://www.w3.org/2000/svg";

function createSVGElement(type, attrs = {}) {
    const el = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

/**
 * Get chart data from real usage stats
 * @param {number} days - Number of days to include
 * @param {string} sourceFilter - Source to filter by, or 'all' for combined
 */
function getChartData(days, sourceFilter = 'all') {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const today = getCurrentEasternTime();
    const { year, month, day } = getEasternParts(today);
    const trackingDayKey = getOutcomeTrackingKeys().day;

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(year, month - 1, day - i, 12, 0, 0);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, models: {}, sources: {} };

        // Filter by source if specified
        let usage, input, output, models;
        if (sourceFilter !== 'all' && dayData.sources && dayData.sources[sourceFilter]) {
            const sourceData = dayData.sources[sourceFilter];
            usage = sourceData.total || 0;
            input = sourceData.input || 0;
            output = sourceData.output || 0;
            models = sourceData.models || {};
        } else if (sourceFilter !== 'all') {
            // Source filter specified but no data for this source on this day
            usage = 0;
            input = 0;
            output = 0;
            models = {};
        } else {
            // 'all' - use combined data
            usage = dayData.total || 0;
            input = dayData.input || 0;
            output = dayData.output || 0;
            models = dayData.models || {};
        }

        const generation = generationPoint(dayData, sourceFilter);

        data.push({
            date: date,
            dayKey: dayKey,
            usage: currentChartMetric === 'generations' ? generation.generations : usage,
            tokensTotal: usage,
            input: input,
            output: output,
            models: models,
            generation: generation,
            outcomesComplete: hasCompleteOutcomes(dayKey, trackingDayKey),
            displayDate: _fmtDayDisplay.format(date),
            fullDate: _fmtDayFull.format(date)
        });
    }
    return data;
}

/**
 * Get hourly chart data from real usage stats
 * @param {number} hours - Number of hours to include
 * @param {string} sourceFilter - Source to filter by, or 'all' for combined
 */
function getHourlyChartData(hours, sourceFilter = 'all') {
    const settings = getSettings();
    const byHour = settings.usage.byHour || {};
    const data = [];
    const now = getCurrentEasternTime();
    const trackingHourKey = getOutcomeTrackingKeys().hour;

    for (let i = hours - 1; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hourKey = getHourKey(date);
        const hourData = byHour[hourKey] || { total: 0, input: 0, output: 0, messageCount: 0, models: {}, sources: {} };

        // Filter by source if specified
        let usage, input, output, models;
        if (sourceFilter !== 'all' && hourData.sources && hourData.sources[sourceFilter]) {
            const sourceData = hourData.sources[sourceFilter];
            usage = sourceData.total || 0;
            input = sourceData.input || 0;
            output = sourceData.output || 0;
            models = {}; // No nested model data in hourly sources
        } else if (sourceFilter !== 'all') {
            usage = 0;
            input = 0;
            output = 0;
            models = {};
        } else {
            usage = hourData.total || 0;
            input = hourData.input || 0;
            output = hourData.output || 0;
            models = hourData.models || {};
        }

        const generation = generationPoint(hourData, sourceFilter);

        data.push({
            date: date,
            hourKey: hourKey,
            usage: currentChartMetric === 'generations' ? generation.generations : usage,
            tokensTotal: usage,
            input: input,
            output: output,
            models: models,
            generation: generation,
            outcomesComplete: hasCompleteOutcomes(hourKey, trackingHourKey),
            displayDate: _fmtHourDisplay.format(date),
            fullDate: _fmtHourFull.format(date)
        });
    }
    return data;
}

/**
 * Get chart data based on current granularity setting
 */
function getChartDataForGranularity() {
    if (currentGranularity === 'hourly') {
        // Map range days to hours: 1D = 24h, 7D = 24*3h = 72h (every 3 hours for a week), 30D = 24*7h = 168h, 90D = 24*14h = 336h
        const hoursMap = { 1: 24, 7: 72, 30: 168, 90: 336 };
        const hours = hoursMap[currentChartRange] || 24;
        return getHourlyChartData(hours, currentSourceFilter);
    }
    return getChartData(currentChartRange, currentSourceFilter);
}

/**
 * Get usage totals for the selected range (in days)
 * @param {number} rangeDays
 * @param {string} sourceFilter
 */
function getRangeTotals(rangeDays, sourceFilter = 'all') {
    const settings = getSettings();
    const byDay = settings.usage.byDay || {};
    const now = getCurrentEasternTime();
    const { year, month, day } = getEasternParts(now);
    const totals = { input: 0, output: 0, reasoning: 0, total: 0, cost: 0, messageCount: 0, stopped: 0, failed: 0 };
    const firstDayKey = getDayKey(new Date(year, month - 1, day - (rangeDays - 1), 12, 0, 0));
    totals.outcomesComplete = hasCompleteOutcomes(firstDayKey, getOutcomeTrackingKeys().day);

    const addCounts = (entry) => {
        totals.messageCount += entry.messageCount || 0;
        totals.stopped += entry.stopped || 0;
        totals.failed += entry.failed || 0;
    };

    for (let i = 0; i < rangeDays; i++) {
        const date = new Date(year, month - 1, day - i, 12, 0, 0);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey];
        if (!dayData) continue;

        if (sourceFilter !== 'all') {
            const sourceData = dayData.sources ? dayData.sources[sourceFilter] : null;
            if (!sourceData) continue;
            addCounts(sourceData);
            totals.input += sourceData.input || 0;
            totals.output += sourceData.output || 0;
            totals.total += sourceData.total || 0;

            if (sourceData.models) {
                for (const [mid, modelData] of Object.entries(sourceData.models)) {
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    totals.cost += calculateCost(mInput, mOutput, mid);
                }
            }
            continue;
        }

        addCounts(dayData);
        totals.input += dayData.input || 0;
        totals.output += dayData.output || 0;
        totals.reasoning += dayData.reasoning || 0;
        totals.total += dayData.total || 0;

        if (dayData.models) {
            for (const [mid, modelData] of Object.entries(dayData.models)) {
                const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                totals.cost += calculateCost(mInput, mOutput, mid);
            }
        }
    }

    return totals;
}

/**
 * Update the header summary to reflect the selected chart range
 */
function updateRangeSummary() {
    const totals = getRangeTotals(currentChartRange, currentSourceFilter);
    const label = currentChartRange === 1 ? 'today' : `last ${currentChartRange} days`;
    const isGenerations = currentChartMetric === 'generations';

    $('#token-usage-summary-tokens').toggle(!isGenerations);
    $('#token-usage-summary-generations').toggle(isGenerations);
    $('#token-usage-chart-note').toggle(isGenerations && currentSourceFilter !== 'all');

    if (isGenerations) {
        const stats = generationStats(totals);
        const rate = formatSuccessRate(stats, totals.outcomesComplete);
        $('#token-usage-today-total').text(formatNumberFull(stats.generations));
        $('#token-usage-today-cost').text(rate === '—' ? '' : `${rate} success`);
        $('#token-usage-range-label').text(currentChartRange === 1 ? 'generations today' : `generations, last ${currentChartRange} days`);
        $('#token-usage-summary-stopped').text(formatNumberFull(stats.stopped));
        $('#token-usage-summary-failed').text(formatNumberFull(stats.failed));
        $('#token-usage-summary-attempts-wrap').toggle(totals.outcomesComplete);
        $('#token-usage-summary-attempts').text(formatNumberFull(stats.attempts));
        return;
    }

    $('#token-usage-today-total').text(formatTokens(totals.total));
    $('#token-usage-today-in').text(formatTokens(totals.input || 0));
    $('#token-usage-today-out').text(formatTokens(totals.output || 0));
    $('#token-usage-today-reasoning').text(formatTokens(totals.reasoning || 0));
    $('#token-usage-today-cost').text(`$${totals.cost.toFixed(2)}`);
    $('#token-usage-range-label').text(label);
}

/**
 * Stacked bar segments for a chart point, bottom first
 * @param {object} d - Chart point
 * @returns {{value: number, color: string, opacity: string}[]}
 */
function getBarSegments(d) {
    if (currentChartMetric === 'generations') {
        const modelEntries = Object.entries(d.generation?.modelCounts || {}).sort((a, b) => b[1] - a[1]);
        const attributed = modelEntries.reduce((sum, [, count]) => sum + count, 0);
        const segments = [];
        // Generations recorded before per-model counts existed share one neutral segment
        if (d.usage > attributed) {
            segments.push({ value: d.usage - attributed, color: 'var(--SmartThemeBodyColor)', opacity: '0.25' });
        }
        for (const [modelId, count] of modelEntries) {
            segments.push({ value: count, color: getModelColor(modelId), opacity: '1' });
        }
        return segments;
    }

    if (!d.models || Object.keys(d.models).length === 0) return [];
    // Extract total from new object format or use number directly for legacy
    const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
    return Object.entries(d.models)
        .sort((a, b) => getTokens(b[1]) - getTokens(a[1])) // Sort by usage desc
        .map(([modelId, modelData]) => ({ value: getTokens(modelData), color: getModelColor(modelId), opacity: '1' }));
}

/**
 * Render the bar chart
 */
function renderChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = { top: 10, right: 10, bottom: 25, left: 45 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;'
    });


    const cursorGroup = createSVGElement('g', { class: 'cursors' });
    const gridGroup = createSVGElement('g', { class: 'grid' });
    const barGroup = createSVGElement('g', { class: 'bars' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(cursorGroup);
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const isGenerations = currentChartMetric === 'generations';
    let step;
    let niceMax;
    if (isGenerations) {
        ({ step, niceMax } = countAxisScale(Math.max(...chartData.map(d => d.usage), 0)));
    } else {
        const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
        const roughStep = maxUsage / 4;
        const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
        step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

        if (step / magnitude < 1.5) step = 1 * magnitude;
        else if (step / magnitude < 3) step = 2.5 * magnitude;
        else if (step / magnitude < 7) step = 5 * magnitude;
        else step = 10 * magnitude;

        niceMax = Math.ceil(maxUsage / step) * step;
        if (niceMax === 0) niceMax = 5000;
    }

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif'
        });
        text.textContent = isGenerations ? formatCount(val) : formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > 40) barWidth = 40;
    const actualGap = totalBarWidth - barWidth;
    const maxLabels = Math.max(2, Math.floor(chartWidth / 40));
    const hourlyLabelInterval = Math.max(1, Math.ceil(chartData.length / maxLabels));
    const labelInterval = currentGranularity === 'hourly'
        ? hourlyLabelInterval
        : (currentChartRange === 90 ? 7 : currentChartRange === 30 ? 3 : 1);
    const xLabelFontSize = chartData.length > 60 ? '9' : '10';

    chartData.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (actualGap / 2);
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Hover area
        const cursor = createSVGElement('rect', {
            x: slotX,
            y: margin.top,
            width: totalBarWidth,
            height: chartHeight,
            fill: 'transparent',
            opacity: '0.1',
            class: 'cursor-rect',
            style: 'cursor: pointer;'
        });

        cursor.addEventListener('mouseenter', () => {
            cursor.setAttribute('fill', CHART_COLORS.cursor);
            showTooltip(d);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);
        const w = barWidth;

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${w} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        const segments = getBarSegments(d);
        if (segments.length > 0 && d.usage > 0) {
            let cumulativeY = barY + h; // Start from bottom

            for (const { value, color, opacity } of segments) {
                const segmentHeight = (value / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: opacity,
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none'
                });
                barGroup.appendChild(segment);

                cumulativeY = segmentY;
            }
        }

        // Draw outer bar border (on top of segments)
        const outerPath = createSVGElement('path', {
            d: outerPathD,
            fill: 'none',
            stroke: CHART_COLORS.bar,
            'stroke-width': '1.5',
            'shape-rendering': 'geometricPrecision',
            'pointer-events': 'none'
        });
        barGroup.appendChild(outerPath);


        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': xLabelFontSize,
                'font-family': 'ui-sans-serif, system-ui, sans-serif'
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    // Single delegated mousemove on the cursor group instead of per-element handlers
    cursorGroup.addEventListener('mousemove', moveTooltip);

    container.appendChild(svg);
}

/**
 * Render the line chart variant
 */
function renderLineChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = { top: 10, right: 10, bottom: 25, left: 45 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;'
    });

    const gridGroup = createSVGElement('g', { class: 'grid' });
    const areaGroup = createSVGElement('g', { class: 'area' });
    const lineGroup = createSVGElement('g', { class: 'lines' });
    const dotGroup = createSVGElement('g', { class: 'dots' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(gridGroup);
    svg.appendChild(areaGroup);
    svg.appendChild(lineGroup);
    svg.appendChild(dotGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const isGenerations = currentChartMetric === 'generations';
    let step;
    let niceMax;
    if (isGenerations) {
        ({ step, niceMax } = countAxisScale(Math.max(...chartData.map(d => d.usage), 0)));
    } else {
        const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
        const roughStep = maxUsage / 4;
        const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
        step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

        if (step / magnitude < 1.5) step = 1 * magnitude;
        else if (step / magnitude < 3) step = 2.5 * magnitude;
        else if (step / magnitude < 7) step = 5 * magnitude;
        else step = 10 * magnitude;

        niceMax = Math.ceil(maxUsage / step) * step;
        if (niceMax === 0) niceMax = 5000;
    }

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;
    const xScale = (i) => margin.left + (i / (chartData.length - 1 || 1)) * chartWidth;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif'
        });
        text.textContent = isGenerations ? formatCount(val) : formatTokens(val);
        textGroup.appendChild(text);
    }

    // Build area path (filled under the line)
    if (chartData.length > 1) {
        let areaPath = `M ${xScale(0)},${margin.top + chartHeight}`;
        chartData.forEach((d, i) => {
            areaPath += ` L ${xScale(i)},${margin.top + yScale(d.usage)}`;
        });
        areaPath += ` L ${xScale(chartData.length - 1)},${margin.top + chartHeight} Z`;

        const area = createSVGElement('path', {
            d: areaPath,
            fill: 'var(--SmartThemeBorderColor)',
            opacity: '0.2',
            'pointer-events': 'none'
        });
        areaGroup.appendChild(area);
    }

    // Build line path
    let linePath = '';
    chartData.forEach((d, i) => {
        const x = xScale(i);
        const y = margin.top + yScale(d.usage);
        linePath += i === 0 ? `M ${x},${y}` : ` L ${x},${y}`;
    });

    const path = createSVGElement('path', {
        d: linePath,
        fill: 'none',
        stroke: 'var(--SmartThemeBodyColor)',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'pointer-events': 'none'
    });
    lineGroup.appendChild(path);

    // Dots and labels
    const maxLabels = Math.max(2, Math.floor(chartWidth / 50));
    const hourlyLabelInterval = Math.max(1, Math.ceil(chartData.length / maxLabels));
    const labelInterval = currentGranularity === 'hourly'
        ? hourlyLabelInterval
        : (chartData.length > 50 ? 7 : chartData.length > 20 ? 3 : 1);
    const dotR = chartData.length > 120 ? 2.5 : chartData.length > 60 ? 3 : 4;
    chartData.forEach((d, i) => {
        const x = xScale(i);
        const y = margin.top + yScale(d.usage);

        // Interactive dot
        const dot = createSVGElement('circle', {
            cx: x,
            cy: y,
            r: dotR,
            fill: 'var(--SmartThemeBodyColor)',
            stroke: 'var(--SmartThemeInputColor)',
            'stroke-width': '2',
            style: 'cursor: pointer;'
        });

        dot.addEventListener('mouseenter', () => {
            dot.setAttribute('r', String(dotR + 2));
            showTooltip(d);
        });
        dot.addEventListener('mouseleave', () => {
            dot.setAttribute('r', String(dotR));
            hideTooltip();
        });
        dotGroup.appendChild(dot);

        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: x,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': '10',
                'font-family': 'ui-sans-serif, system-ui, sans-serif'
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    // Single delegated mousemove on the dot group instead of per-element handlers
    dotGroup.addEventListener('mousemove', moveTooltip);

    container.appendChild(svg);
}

/**
 * Render chart based on current chart type
 */
function renderChartByType() {
    if (currentChartType === 'line') {
        renderLineChart();
    } else {
        renderChart();
    }
}

function showTooltip(d) {
    if (!tooltip) return;

    if (currentChartMetric === 'generations') {
        showGenerationTooltip(d);
        return;
    }

    // Calculate total cost for this timeframe
    let totalCost = 0;
    let modelCosts = {};

    if (d.models && Object.keys(d.models).length > 0) {
        for (const [model, modelData] of Object.entries(d.models)) {
            // Extract input/output from new object format, estimate for legacy number format
            let inputTokens, outputTokens;
            if (typeof modelData === 'number') {
                // Legacy format: estimate 50/50 split
                inputTokens = Math.round(modelData * 0.5);
                outputTokens = Math.round(modelData * 0.5);
            } else {
                inputTokens = modelData.input || 0;
                outputTokens = modelData.output || 0;
            }
            const cost = calculateCost(inputTokens, outputTokens, model);
            modelCosts[model] = cost;
            totalCost += cost;
        }
    }

    // Build model breakdown HTML with costs
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        // Extract total from new object format or use number directly for legacy
        const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
        const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(a[1]) - getTokens(b[1])); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        for (const [model, modelData] of displayEntries) {
            const tokens = getTokens(modelData);
            const percent = d.usage > 0 ? Math.round((tokens / d.usage) * 100) : 0;
            const shortName = escapeHtml(model.length > 25 ? model.substring(0, 22) + '...' : model);
            const color = getModelColor(model);
            const modelCost = modelCosts[model] || 0;
            const costDisplay = modelCost > 0 ? ` · $${modelCost.toFixed(4)}` : '';
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatTokens(tokens)} (${percent}%)${costDisplay}</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    // Build cost display line
    const costLine = totalCost > 0
        ? `<div style="font-size: 10px; color: #4ade80; font-weight: 500;">Cost: $${totalCost.toFixed(4)}</div>`
        : '';

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} tokens</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.input)} in / ${formatNumberFull(d.output)} out</div>
        ${costLine}
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

/**
 * Tooltip content for the Generations chart metric
 * @param {object} d - Chart point
 */
function showGenerationTooltip(d) {
    const stats = d.generation || generationStats();
    let outcomeLine = '';
    if (d.outcomesComplete && stats.attempts > 0) {
        outcomeLine = `${stats.stopped} stopped · ${stats.failed} failed · ${formatSuccessRate(stats, true)} success`;
    } else if (stats.stopped > 0 || stats.failed > 0) {
        outcomeLine = `${stats.stopped} stopped · ${stats.failed} failed`;
    }

    let modelBreakdown = '';
    const modelEntries = Object.entries(stats.modelCounts || {}).sort((a, b) => a[1] - b[1]); // Ascending, like the bars bottom-up
    if (modelEntries.length > 0) {
        modelBreakdown = '<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2);">';
        for (const [model, count] of modelEntries.slice(-8)) {
            const percent = d.usage > 0 ? Math.round((count / d.usage) * 100) : 0;
            const shortName = escapeHtml(model.length > 25 ? model.substring(0, 22) + '...' : model);
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${getModelColor(model)}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatNumberFull(count)} (${percent}%)</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} generation${d.usage === 1 ? '' : 's'}</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.tokensTotal || 0)} tokens</div>
        ${outcomeLine ? `<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.8;">${outcomeLine}</div>` : ''}
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

let _tooltipRafPending = false;
let _tooltipPendingClientX = 0;
let _tooltipPendingClientY = 0;

function moveTooltip(e) {
    if (!tooltip) return;

    _tooltipPendingClientX = e.clientX;
    _tooltipPendingClientY = e.clientY;

    if (_tooltipRafPending) return;
    _tooltipRafPending = true;

    requestAnimationFrame(() => {
        _tooltipRafPending = false;
        if (!tooltip || tooltip.style.display === 'none') return;

        const tooltipWidth = tooltip.offsetWidth || 150;
        const tooltipHeight = tooltip.offsetHeight || 60;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let x = _tooltipPendingClientX + 15;
        let y = _tooltipPendingClientY - 10;

        // Keep tooltip within viewport
        if (x + tooltipWidth > viewportWidth - 10) {
            x = _tooltipPendingClientX - tooltipWidth - 15;
        }
        if (y + tooltipHeight > viewportHeight - 10) {
            y = viewportHeight - tooltipHeight - 10;
        }
        if (y < 10) {
            y = 10;
        }
        if (x < 10) {
            x = 10;
        }

        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
    });
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartDataForGranularity();
    renderChartByType();
    updateRangeSummary();

    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        const val = parseInt(btn.getAttribute('data-value'));
        if (val === range) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

/**
 * Update source filter and refresh display
 */
function updateSourceFilter(sourceId) {
    currentSourceFilter = sourceId;
    chartData = getChartDataForGranularity();
    renderChartByType();
    updateRangeSummary();
    updateUIStats();
}

/**
 * Get list of sources that have recorded usage
 */
function getAvailableSources() {
    const settings = getSettings();
    const sources = Object.keys(settings.usage.bySource || {}).sort();
    return sources;
}

/**
 * Format source name for display (make it more readable)
 */
function formatSourceName(sourceId) {
    const names = {
        'openai': 'OpenAI',
        'custom': 'Custom (OpenAI-compatible)',
        'claude': 'Claude',
        'windowai': 'Window AI',
        'openrouter': 'OpenRouter',
        'ai21': 'AI21',
        'mistralai': 'Mistral AI',
        'makersuite': 'Google AI',
        'groq': 'Groq',
        'textgenerationwebui': 'Text Gen WebUI',
        'novel': 'NovelAI',
        'kobold': 'KoboldAI',
        'horde': 'AI Horde',
        'unknown': 'Unknown'
    };
    return names[sourceId] || sourceId;
}

/**
 * Update the source dropdown options
 */
function updateSourceDropdown() {
    const dropdown = $('#token-usage-source-filter');
    if (dropdown.length === 0) return;

    const sources = getAvailableSources();
    const currentValue = dropdown.val();

    // Rebuild options
    dropdown.empty();
    dropdown.append('<option value="all">All Sources</option>');

    for (const source of sources) {
        const displayName = formatSourceName(source);
        dropdown.append(`<option value="${escapeHtml(source)}">${escapeHtml(displayName)}</option>`);
    }

    // Restore selection if still valid
    if (currentValue && (currentValue === 'all' || sources.includes(currentValue))) {
        dropdown.val(currentValue);
    } else {
        dropdown.val('all');
        currentSourceFilter = 'all';
    }
}

/**
 * Update the stats display in the UI
 */
function updateUIStats() {
    const stats = getUsageStats();
    const now = getCurrentEasternTime();

    // Today header
    $('#token-usage-mini-counter').text(formatTokens(stats.today.total));

    // If the settings panel is collapsed/hidden, only update miniview and header counter
    const panelContent = document.querySelector('#token-usage-main-content');
    if (!panelContent || panelContent.offsetParent === null) {
        modelConfigState.needsRefresh = true;
        updateMiniviewStats(stats);
        return;
    }

    // Stats grid
    $('#token-usage-week-total').text(formatTokens(stats.thisWeek.total));
    $('#token-usage-month-total').text(formatTokens(stats.thisMonth.total));
    $('#token-usage-alltime-total').text(formatTokens(stats.allTime.total));

    // Cost calculations
    const allTimeCost = calculateAllTimeCost();

    if (allTimeCost > 0) {
        $('#token-usage-alltime-cost').text(`$${allTimeCost.toFixed(2)}`);
    } else {
        $('#token-usage-alltime-cost').text('$0.00');
    }

    // For Week/Month: We iterate all `byDay` keys and match those that belong to current week/month
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);

    let weekCost = 0;
    let monthCost = 0;

    const settings = getSettings();
    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        // Parse dayKey (YYYY-MM-DD) as local date, not UTC
        // new Date("2026-01-01") interprets as UTC, which shifts timezone
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        // Week check
        if (getWeekKey(date) === currentWeekKey) {
            // Calculate cost for this day using per-model input/output breakdown
            if (data.models) {
                for (const [mid, modelData] of Object.entries(data.models)) {
                    // modelData is now { input, output, total } (or number for legacy data)
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    weekCost += calculateCost(mInput, mOutput, mid);
                }
            }
        }
        // Month check
        if (getMonthKey(date) === currentMonthKey) {
            if (data.models) {
                for (const [mid, modelData] of Object.entries(data.models)) {
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    monthCost += calculateCost(mInput, mOutput, mid);
                }
            }
        }
    }

    $('#token-usage-week-cost').text(`$${weekCost.toFixed(2)}`);
    $('#token-usage-month-cost').text(`$${monthCost.toFixed(2)}`);

    $('#token-usage-tokenizer').text('Tokenizer: ' + (stats.tokenizer || 'Unknown'));

    // Update efficiency metrics
    const sessionEfficiency = calculateEfficiencyMetrics(stats.session);
    const allTimeEfficiency = calculateEfficiencyMetrics(stats.allTime);

    $('#token-usage-efficiency-ratio').text(sessionEfficiency.ratio.toFixed(2) + '×');
    $('#token-usage-efficiency-permsg').text(formatTokens(sessionEfficiency.perMessage));
    $('#token-usage-efficiency-alltime-ratio').text(allTimeEfficiency.ratio.toFixed(2) + '×');
    $('#token-usage-efficiency-alltime-permsg').text(formatTokens(allTimeEfficiency.perMessage));

    // Update chart data with current granularity and source filter
    chartData = getChartDataForGranularity();
    renderChartByType();

    // Update the range-based header summary
    updateRangeSummary();

    // Update source dropdown options (in case new sources were added)
    updateSourceDropdown();

    // Update model config state and lazily render when the config drawer is visible
    const modelCount = Object.keys(stats.byModel || {}).length;
    if (modelCount !== modelConfigState.lastModelCount) {
        modelConfigState.needsRefresh = true;
    }

    const wasConfigOpen = modelConfigState.isOpen;
    modelConfigState.isOpen = isModelConfigVisible();
    if (modelConfigState.isOpen) {
        if (!wasConfigOpen || modelConfigState.needsRefresh) {
            scheduleModelConfigRender(stats, !wasConfigOpen);
        }
    } else {
        modelConfigState.needsRefresh = true;
    }

    // Update current chat usage
    updateChatUsageDisplay();

    // Update health indicator
    updateHealthIndicator();

    // Update miniview if visible
    updateMiniviewStats(stats);
}


/**
 * Update the health indicator in the UI header
 */
function updateHealthIndicator() {
    const health = getHealthStatus();
    const indicator = $('#token-usage-health-indicator');
    if (indicator.length === 0) return;

    const statusEmoji = {
        'healthy': '🟢',
        'warning': '🟡',
        'error': '🔴'
    };

    let tooltipText = `Status: ${health.status}`;
    if (health.lastActivity) {
        tooltipText += `\nLast activity: ${health.lastActivity}`;
    }
    if (health.details.lastError) {
        tooltipText += `\nLast error: ${health.details.lastError}`;
    }
    if (!health.details.tokenizerAvailable) {
        tooltipText += '\nWarning: Tokenizer not available';
    }

    indicator.text(statusEmoji[health.status] || '🟡');
    indicator.attr('title', tooltipText);
}


/**
 * Update the current chat usage display
 */
function updateChatUsageDisplay() {
    const chatId = getCurrentChatId();

    if (!chatId) {
        $('#token-usage-chat-total').text('0');
        $('#token-usage-chat-messages').text('0');
        $('#token-usage-chat-input').text('0');
        $('#token-usage-chat-output').text('0');
        $('#token-usage-chat-cost').text('$0.00');
        $('#token-usage-chat-id').text('No chat active');
        return;
    }

    const chatUsage = getChatUsage(chatId);

    // Calculate chat cost from per-model usage
    let chatCost = 0;
    if (chatUsage.models) {
        for (const [mid, modelData] of Object.entries(chatUsage.models)) {
            const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
            const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
            chatCost += calculateCost(mInput, mOutput, mid);
        }
    }

    $('#token-usage-chat-total').text(formatTokens(chatUsage.total));
    $('#token-usage-chat-messages').text(chatUsage.messageCount);
    $('#token-usage-chat-input').text(formatTokens(chatUsage.input));
    $('#token-usage-chat-output').text(formatTokens(chatUsage.output));
    $('#token-usage-chat-cost').text(`$${chatCost.toFixed(2)}`);
    $('#token-usage-chat-id').text(`Chat: ${chatId}`);
}


/**
 * Create the floating compact miniview
 */
function createMiniview() {
    if (miniviewElement) return; // Already created

    const settings = getSettings();
    const stats = getUsageStats();
    const isPinned = settings.miniview?.pinned || false;
    const mode = settings.miniview?.mode || 'session';

    const html = `
        <div id="token-usage-miniview" class="token-usage-miniview ${isPinned ? 'pinned' : ''}" style="display: ${isPinned ? 'block' : 'none'};">
            <div class="miniview-header">
                <span class="miniview-title">📊 Tokens</span>
                <div class="miniview-controls">
                    <button class="miniview-mode-btn" title="Toggle data view (Session/Hourly/Daily)">
                        <span class="miniview-mode-label">${mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
                    </button>
                    <button class="miniview-pin-btn ${isPinned ? 'active' : ''}" title="${isPinned ? 'Unpin miniview' : 'Pin miniview'}">
                        📌
                    </button>
                    <button class="miniview-close-btn" title="Close miniview">×</button>
                </div>
            </div>
            <div class="miniview-body">
                <div class="miniview-stat-row">
                    <span class="miniview-stat-label">Total</span>
                    <span class="miniview-stat-value" id="miniview-total">0</span>
                </div>
                <div class="miniview-stat-row miniview-stat-secondary">
                    <span class="miniview-stat-label">In/Out</span>
                    <span class="miniview-stat-value">
                        <span id="miniview-input">0</span> / <span id="miniview-output">0</span>
                    </span>
                </div>
                <div class="miniview-stat-row miniview-stat-secondary">
                    <span class="miniview-stat-label">🧠 Reasoning</span>
                    <span class="miniview-stat-value" id="miniview-reasoning">0</span>
                </div>
                <div class="miniview-stat-row miniview-stat-secondary">
                    <span class="miniview-stat-label">Generations</span>
                    <span class="miniview-stat-value" id="miniview-messages">0</span>
                </div>
                <div class="miniview-stat-row miniview-stat-cost">
                    <span class="miniview-stat-label">Cost</span>
                    <span class="miniview-stat-value" id="miniview-cost">$0.00</span>
                </div>
            </div>
            <div class="miniview-resize-handle" title="Drag to resize"></div>
        </div>
    `;

    // Append to body for proper positioning
    $('body').append(html);
    miniviewElement = document.getElementById('token-usage-miniview');

    // Event handlers
    $('.miniview-pin-btn').on('click', toggleMiniviewPin);
    $('.miniview-close-btn').on('click', hideMiniview);
    $('.miniview-mode-btn').on('click', cycleMiniviewMode);

    // Setup drag and drop
    setupMiniviewDrag();

    // Setup resize
    setupMiniviewResize();

    // Apply saved position and size
    applyMiniviewPosition();
    applyMiniviewSize();

    // Initial update
    updateMiniviewStats();
}

/**
 * Show the miniview
 */
function showMiniview() {
    if (!miniviewElement) {
        createMiniview();
    }
    // Show the element first so we can measure its actual size
    $(miniviewElement).fadeIn(150, function () {
        // Use requestAnimationFrame to ensure the DOM has updated before measuring
        requestAnimationFrame(() => {
            // Re-apply position after visible, so getBoundingClientRect works correctly
            applyMiniviewPosition();
        });
    });
}

/**
 * Hide the miniview
 */
function hideMiniview() {
    if (miniviewElement) {
        $(miniviewElement).fadeOut(150);
        // If it was pinned, unpin it
        const settings = getSettings();
        if (settings.miniview?.pinned) {
            settings.miniview.pinned = false;
            saveSettings();
            $('.miniview-pin-btn').removeClass('active');
        }
    }
}

/**
 * Toggle miniview visibility
 */
function toggleMiniview() {
    if (!miniviewElement) {
        createMiniview();
        showMiniview();
    } else if ($(miniviewElement).is(':visible')) {
        hideMiniview();
    } else {
        showMiniview();
    }
}

/**
 * Toggle pin state of the miniview
 */
function toggleMiniviewPin() {
    const settings = getSettings();
    if (!settings.miniview) {
        settings.miniview = { pinned: false, mode: 'session' };
    }
    settings.miniview.pinned = !settings.miniview.pinned;
    saveSettings();

    const $btn = $('.miniview-pin-btn');
    if (settings.miniview.pinned) {
        $btn.addClass('active');
        $btn.attr('title', 'Unpin miniview');
    } else {
        $btn.removeClass('active');
        $btn.attr('title', 'Pin miniview');
    }

    $(miniviewElement).toggleClass('pinned', settings.miniview.pinned);
}

/**
 * Cycle through miniview data modes: session → hourly → daily → session
 */
function cycleMiniviewMode() {
    const settings = getSettings();
    if (!settings.miniview) {
        settings.miniview = { pinned: false, mode: 'session' };
    }

    const modes = ['session', 'hourly', 'daily'];
    const currentIndex = modes.indexOf(settings.miniview.mode);
    const nextIndex = (currentIndex + 1) % modes.length;
    settings.miniview.mode = modes[nextIndex];
    saveSettings();

    // Update button label
    $('.miniview-mode-label').text(settings.miniview.mode.charAt(0).toUpperCase() + settings.miniview.mode.slice(1));

    // Refresh stats
    updateMiniviewStats();
}

/**
 * Apply saved position to miniview
 * NOTE: Uses top/left positioning instead of bottom/right because SillyTavern's
 * HTML element has perspective:1000px which creates a containing block that breaks
 * fixed positioning when combined with bottom/right on some viewport configurations.
 */
function applyMiniviewPosition() {
    if (!miniviewElement) return;

    const settings = getSettings();
    const savedPosition = settings.miniview?.position || { bottom: 80, right: 20 };

    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Get miniview dimensions - measure actual element if visible, otherwise use conservative estimates
    let width, height;
    const isVisible = $(miniviewElement).is(':visible') || miniviewElement.style.display !== 'none';

    if (isVisible) {
        const rect = miniviewElement.getBoundingClientRect();
        width = rect.width || 180;
        height = rect.height || 200;
    } else {
        // When hidden, use saved size or conservative estimates
        const size = settings.miniview?.size || { width: 180, height: null };
        width = size.width || 180;
        height = size.height || 200;
    }

    // Ensure we have reasonable minimums
    width = Math.max(width, 140);
    height = Math.max(height, 150);

    // Convert saved bottom/right to top/left
    // bottom: X means element bottom is X px from viewport bottom
    // So top = viewportHeight - bottom - height
    // right: X means element right is X px from viewport right
    // So left = viewportWidth - right - width
    let top = viewportHeight - savedPosition.bottom - height;
    let left = viewportWidth - savedPosition.right - width;

    // Clamp to viewport bounds (with 10px margin)
    const minTop = 10;
    const maxTop = viewportHeight - height - 10;
    const minLeft = 10;
    const maxLeft = viewportWidth - width - 10;

    top = Math.max(minTop, Math.min(top, maxTop));
    left = Math.max(minLeft, Math.min(left, maxLeft));

    // Apply position using top/left (more reliable with SillyTavern's CSS)
    miniviewElement.style.top = `${top}px`;
    miniviewElement.style.left = `${left}px`;
    miniviewElement.style.bottom = 'auto';
    miniviewElement.style.right = 'auto';

    // Convert back to bottom/right for saving (maintains compatibility with existing settings)
    const newBottom = viewportHeight - top - height;
    const newRight = viewportWidth - left - width;

    // Save corrected position if it was out of bounds
    if (Math.abs(newBottom - savedPosition.bottom) > 1 || Math.abs(newRight - savedPosition.right) > 1) {
        if (!settings.miniview) {
            settings.miniview = { pinned: false, mode: 'session', position: {} };
        }
        if (!settings.miniview.position) {
            settings.miniview.position = {};
        }
        settings.miniview.position.bottom = Math.round(newBottom);
        settings.miniview.position.right = Math.round(newRight);
        saveSettings();
    }
}

/**
 * Handle window resize to keep miniview within viewport
 */
function handleMiniviewResize() {
    if (!miniviewElement || !$(miniviewElement).is(':visible')) return;
    applyMiniviewPosition();
}

// Debounced resize handler
let miniviewResizeTimer = null;
function debouncedMiniviewResize() {
    clearTimeout(miniviewResizeTimer);
    miniviewResizeTimer = setTimeout(handleMiniviewResize, 100);
}

/**
 * Setup drag and drop for miniview
 * Uses top/left positioning to match applyMiniviewPosition
 */
function setupMiniviewDrag() {
    if (!miniviewElement) return;

    const header = miniviewElement.querySelector('.miniview-header');
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    // Make header show it's draggable
    header.style.cursor = 'grab';

    const onMouseDown = (e) => {
        // Don't start drag if clicking a button
        if (e.target.closest('button')) return;

        isDragging = true;
        header.style.cursor = 'grabbing';

        // Get starting mouse position
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        // Get current position from computed style (top/left)
        const style = window.getComputedStyle(miniviewElement);
        startTop = parseInt(style.top, 10);
        startLeft = parseInt(style.left, 10);

        // If top/left are auto, calculate from bounding rect
        if (isNaN(startTop) || isNaN(startLeft)) {
            const rect = miniviewElement.getBoundingClientRect();
            startTop = rect.top;
            startLeft = rect.left;
        }

        // Only add move/up listeners while dragging, so they don't fire on every event globally
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchmove', onMouseMove, { passive: true });
        document.addEventListener('touchend', onMouseUp);

        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Calculate movement deltas
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;

        // Calculate new position
        let newTop = startTop + deltaY;
        let newLeft = startLeft + deltaX;

        // Constrain to viewport
        const rect = miniviewElement.getBoundingClientRect();
        const maxTop = window.innerHeight - rect.height - 10;
        const maxLeft = window.innerWidth - rect.width - 10;

        newTop = Math.max(10, Math.min(newTop, maxTop));
        newLeft = Math.max(10, Math.min(newLeft, maxLeft));

        // Apply new position using top/left
        miniviewElement.style.top = `${newTop}px`;
        miniviewElement.style.left = `${newLeft}px`;
        miniviewElement.style.bottom = 'auto';
        miniviewElement.style.right = 'auto';
    };

    const onMouseUp = () => {
        if (!isDragging) return;

        isDragging = false;
        header.style.cursor = 'grab';

        // Remove listeners now that drag is done
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onMouseMove);
        document.removeEventListener('touchend', onMouseUp);

        // Save position to settings (convert to bottom/right for backward compatibility)
        const rect = miniviewElement.getBoundingClientRect();
        const settings = getSettings();
        if (!settings.miniview) {
            settings.miniview = { pinned: false, mode: 'session', position: {} };
        }
        if (!settings.miniview.position) {
            settings.miniview.position = {};
        }
        // Save as bottom/right for compatibility with existing settings format
        settings.miniview.position.bottom = Math.round(window.innerHeight - rect.bottom);
        settings.miniview.position.right = Math.round(window.innerWidth - rect.right);
        saveSettings();
    };

    // Only attach the mousedown/touchstart to the header; move/up listeners are added dynamically
    header.addEventListener('mousedown', onMouseDown);
    header.addEventListener('touchstart', onMouseDown, { passive: false });
}

/**
 * Apply saved size to miniview
 */
function applyMiniviewSize() {
    if (!miniviewElement) return;

    const settings = getSettings();
    const size = settings.miniview?.size || { width: 180, height: null };

    if (size.width) {
        miniviewElement.style.width = `${size.width}px`;
    }
    if (size.height) {
        miniviewElement.style.height = `${size.height}px`;
    }
}

/**
 * Setup resize functionality for miniview
 */
function setupMiniviewResize() {
    if (!miniviewElement) return;

    const handle = miniviewElement.querySelector('.miniview-resize-handle');
    if (!handle) return;

    let isResizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    const onMouseDown = (e) => {
        isResizing = true;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        const rect = miniviewElement.getBoundingClientRect();
        startWidth = rect.width;
        startHeight = rect.height;

        // Only add move/up listeners while resizing, so they don't fire on every event globally
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchmove', onMouseMove, { passive: true });
        document.addEventListener('touchend', onMouseUp);

        e.preventDefault();
        e.stopPropagation();
    };

    const onMouseMove = (e) => {
        if (!isResizing) return;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Since handle is bottom-left, dragging left increases width, dragging down increases height
        const deltaX = startX - clientX;
        const deltaY = clientY - startY;

        // Calculate new size with constraints
        const newWidth = Math.max(140, Math.min(startWidth + deltaX, 400));
        const newHeight = Math.max(100, Math.min(startHeight + deltaY, 500));

        miniviewElement.style.width = `${newWidth}px`;
        miniviewElement.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => {
        if (!isResizing) return;

        isResizing = false;

        // Remove listeners now that resize is done
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onMouseMove);
        document.removeEventListener('touchend', onMouseUp);

        // Save size to settings
        const rect = miniviewElement.getBoundingClientRect();
        const settings = getSettings();
        if (!settings.miniview) {
            settings.miniview = { pinned: false, mode: 'session', position: {}, size: {} };
        }
        if (!settings.miniview.size) {
            settings.miniview.size = {};
        }
        settings.miniview.size.width = Math.round(rect.width);
        settings.miniview.size.height = Math.round(rect.height);
        saveSettings();
    };

    // Only attach the mousedown/touchstart to the handle; move/up listeners are added dynamically
    handle.addEventListener('mousedown', onMouseDown);
    handle.addEventListener('touchstart', onMouseDown, { passive: false });
}

/**
 * Update miniview stats based on current mode
 */
function updateMiniviewStats(statsParam) {
    if (!miniviewElement) return;

    const settings = getSettings();
    const mode = settings.miniview?.mode || 'session';
    const stats = statsParam || getUsageStats();
    const now = getCurrentEasternTime();

    let data;
    let cost = 0;

    switch (mode) {
        case 'session':
            data = stats.session;
            // Calculate session cost from per-model usage
            if (settings.usage.session.models) {
                for (const [mid, modelData] of Object.entries(settings.usage.session.models)) {
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    cost += calculateCost(mInput, mOutput, mid);
                }
            }
            break;

        case 'hourly':
            // Get current hour's data
            const hourKey = getHourKey(now);
            const hourData = settings.usage.byHour?.[hourKey] || { input: 0, output: 0, total: 0, reasoning: 0, messageCount: 0 };
            data = {
                input: hourData.input || 0,
                output: hourData.output || 0,
                total: hourData.total || 0,
                reasoning: hourData.reasoning || 0,
                messageCount: hourData.messageCount || 0
            };
            // Calculate hourly cost from models
            if (hourData.models) {
                for (const [mid, modelData] of Object.entries(hourData.models)) {
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    cost += calculateCost(mInput, mOutput, mid);
                }
            }
            break;

        case 'daily':
            data = stats.today;
            // Calculate today's cost
            const todayKey = getDayKey(now);
            const dayData = settings.usage.byDay?.[todayKey];
            if (dayData?.models) {
                for (const [mid, modelData] of Object.entries(dayData.models)) {
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    cost += calculateCost(mInput, mOutput, mid);
                }
            }
            break;

        default:
            data = stats.session;
    }

    // Update DOM
    $('#miniview-total').text(formatTokens(data.total || 0));
    $('#miniview-input').text(formatTokens(data.input || 0));
    $('#miniview-output').text(formatTokens(data.output || 0));
    $('#miniview-reasoning').text(formatTokens(data.reasoning || 0));
    $('#miniview-messages').text(data.messageCount || 0);
    $('#miniview-cost').text(`$${cost.toFixed(2)}`);
}


function isModelConfigVisible() {
    const configContent = document.getElementById('token-usage-config-content');
    return Boolean(configContent && configContent.offsetParent !== null);
}

function updateModelConfigControls(totalModels, filteredCount, startIndex, endIndex, totalPages) {
    const summary = $('#token-usage-model-summary');
    const pageLabel = $('#token-usage-model-page-label');
    const prevBtn = $('#token-usage-model-prev');
    const nextBtn = $('#token-usage-model-next');

    if (!summary.length || !pageLabel.length || !prevBtn.length || !nextBtn.length) return;

    if (totalModels === 0) {
        summary.text('No models tracked yet');
        pageLabel.text('0 / 0');
        prevBtn.prop('disabled', true);
        nextBtn.prop('disabled', true);
        return;
    }

    if (filteredCount === 0) {
        summary.text(`No models match "${modelConfigState.query}"`);
        pageLabel.text('0 / 0');
        prevBtn.prop('disabled', true);
        nextBtn.prop('disabled', true);
        return;
    }

    if (filteredCount !== totalModels) {
        summary.text(`Showing ${startIndex}-${endIndex} of ${filteredCount} matches (${totalModels} total)`);
    } else {
        summary.text(`Showing ${startIndex}-${endIndex} of ${totalModels} model groups`);
    }

    pageLabel.text(`${modelConfigState.page} / ${totalPages}`);
    prevBtn.prop('disabled', modelConfigState.page <= 1);
    nextBtn.prop('disabled', modelConfigState.page >= totalPages);
}

function scheduleModelConfigRender(statsParam = null, force = false) {
    if (statsParam) {
        modelConfigPendingStats = statsParam;
    }
    modelConfigPendingForce = modelConfigPendingForce || force;

    if (modelConfigRenderRaf !== null) return;

    const runRender = () => {
        modelConfigRenderRaf = null;
        const statsForRender = modelConfigPendingStats;
        const forceRender = modelConfigPendingForce;
        modelConfigPendingStats = null;
        modelConfigPendingForce = false;
        renderModelColorsGrid(statsForRender, { force: forceRender });
    };

    if (typeof requestAnimationFrame === 'function') {
        modelConfigRenderRaf = requestAnimationFrame(runRender);
    } else {
        modelConfigRenderRaf = setTimeout(runRender, 0);
    }
}

function syncModelConfigVisibility(forceRender = false) {
    const wasOpen = modelConfigState.isOpen;
    const isOpen = isModelConfigVisible();
    modelConfigState.isOpen = isOpen;

    if (!isOpen) return;

    if (forceRender || !wasOpen || modelConfigState.needsRefresh) {
        scheduleModelConfigRender(null, true);
    }
}

function bindModelConfigControls() {
    const searchInput = $('#token-usage-model-search');
    const prevBtn = $('#token-usage-model-prev');
    const nextBtn = $('#token-usage-model-next');
    const grid = $('#token-usage-model-colors-grid');

    searchInput.off('.tokenUsageConfig');
    prevBtn.off('.tokenUsageConfig');
    nextBtn.off('.tokenUsageConfig');
    grid.off('.tokenUsageConfig');

    $('#token-usage-bulk-apply').off('.tokenUsageConfig').on('click.tokenUsageConfig', () => {
        // Read the live search so a click before the search debounce finishes
        // never applies prices to an earlier query or just the current page.
        const query = String(searchInput.val() || '').trim().toLowerCase();
        try {
            const models = applyMatchingPrices(getSettings(), Object.keys(getUsageStats().byModel || {}), query,
                $('#token-usage-bulk-in').val(), $('#token-usage-bulk-out').val());
            if (!models.length) {
                toastr.warning('No model IDs match this search');
                return;
            }
            clearTimeout(modelConfigSearchTimer);
            if (query !== modelConfigState.query) modelConfigState.page = 1;
            modelConfigState.query = query;
            for (const model of models) modelConfigPriceDrafts.delete('model:' + model);
            refreshPricing();
            toastr.success(`Updated pricing for ${models.length} matching model${models.length === 1 ? '' : 's'}`);
        } catch (error) {
            toastr.warning(error.message);
        }
    });

    searchInput.on('input.tokenUsageConfig', function () {
        const rawQuery = String($(this).val() || '');
        clearTimeout(modelConfigSearchTimer);
        modelConfigSearchTimer = setTimeout(() => {
            modelConfigState.query = rawQuery.trim().toLowerCase();
            modelConfigState.page = 1;
            scheduleModelConfigRender(null, true);
        }, MODEL_CONFIG_SEARCH_DEBOUNCE_MS);
    });
    prevBtn.on('click.tokenUsageConfig', () => {
        modelConfigState.page = Math.max(1, modelConfigState.page - 1);
        scheduleModelConfigRender(null, true);
    });
    nextBtn.on('click.tokenUsageConfig', () => {
        modelConfigState.page += 1;
        scheduleModelConfigRender(null, true);
    });

    grid.on('click.tokenUsageConfig', '.price-group-toggle', function () {
        const group = $(this).attr('data-group');
        if (expandedPriceGroups.has(group)) expandedPriceGroups.delete(group);
        else expandedPriceGroups.add(group);
        scheduleModelConfigRender(null, true);
    });

    // Explicit Save buttons keep partial input intact while stats refresh.
    grid.on('input.tokenUsageConfig', '.price-editor input', function () {
        const row = $(this).closest('.price-editor');
        modelConfigPriceDrafts.set(row.attr('data-editor'), {
            in: String(row.find('.price-input-in').val() ?? ''),
            out: String(row.find('.price-input-out').val() ?? ''),
        });
    });
    grid.on('click.tokenUsageConfig', '.price-save', function () {
        const row = $(this).closest('.price-editor');
        const price = parsePrice(row.find('.price-input-in').val(), row.find('.price-input-out').val());
        if (!price) {
            toastr.warning('Enter both prices as non-negative numbers. Use 0 for free tokens.');
            return;
        }
        const settings = getSettings();
        const group = row.attr('data-group');
        const model = row.attr('data-model');
        if (group) saveSharedPrice(settings, group, price);
        else settings.modelPrices = { ...settings.modelPrices, [model]: price };
        modelConfigPriceDrafts.delete(row.attr('data-editor'));
        refreshPricing();
        toastr.success(group ? 'Shared price saved; individual overrides kept' : 'Model override saved');
    });
    grid.on('click.tokenUsageConfig', '.price-inherit', function () {
        const model = $(this).attr('data-model');
        delete getSettings().modelPrices[model];
        modelConfigPriceDrafts.delete('model:' + model);
        refreshPricing();
    });
    grid.on('click.tokenUsageConfig', '.price-auto', function () {
        const group = $(this).attr('data-group');
        delete getSettings().sharedModelPrices[group];
        modelConfigPriceDrafts.delete('group:' + group);
        refreshPricing();
    });
    grid.on('change.tokenUsageConfig', '.price-group-link', function () {
        const model = $(this).attr('data-model');
        const group = String($(this).val() || '');
        if (!group) return;
        getSettings().modelPriceGroups = { ...getSettings().modelPriceGroups, [model]: group };
        expandedPriceGroups.add(group);
        modelConfigPriceDrafts.delete('model:' + model);
        refreshPricing();
    });
    grid.on('click.tokenUsageConfig', '.price-separate', function () {
        const model = $(this).attr('data-model');
        const settings = getSettings();
        // Preserve the effective price when moving out of a shared group.
        if (configuredPrice(settings, model)) settings.modelPrices = { ...settings.modelPrices, [model]: { ...getModelPrice(model) } };
        settings.modelPriceGroups = { ...settings.modelPriceGroups, [model]: 'exact:' + model };
        expandedPriceGroups.add('exact:' + model);
        modelConfigPriceDrafts.delete('model:' + model);
        refreshPricing();
    });
    grid.on('change.tokenUsageConfig', '.model-color-picker', function () {
        setModelColor($(this).attr('data-model'), String($(this).val() || ''));
        renderChartByType();
    });
}

function refreshPricing() {
    invalidateModelPriceCache();
    modelConfigState.needsRefresh = true;
    saveSettings();
    updateUIStats();
    scheduleModelConfigRender(null, true);
}

function observeModelConfigVisibility() {
    if (typeof MutationObserver === 'undefined') return;

    const mainContent = document.getElementById('token-usage-main-content');
    const configContent = document.getElementById('token-usage-config-content');
    if (!mainContent || !configContent) return;

    if (modelConfigVisibilityObserver) {
        modelConfigVisibilityObserver.disconnect();
    }

    modelConfigVisibilityObserver = new MutationObserver(() => {
        syncModelConfigVisibility();
    });

    const options = { attributes: true, attributeFilter: ['class', 'style'] };
    modelConfigVisibilityObserver.observe(mainContent, options);
    modelConfigVisibilityObserver.observe(configContent, options);
}

/**
 * Render the model colors grid with search + pagination
 */
function renderModelColorsGrid(statsParam, options = {}) {
    const grid = $('#token-usage-model-colors-grid');
    if (!grid.length) return;
    if (!isModelConfigVisible() && !options.force) {
        modelConfigState.needsRefresh = true;
        return;
    }
    const stats = statsParam || getUsageStats();
    const settings = getSettings();
    const models = Object.keys(stats.byModel || {});
    const signature = models.join('\u0001');
    if (!options.force && !modelConfigState.needsRefresh
        && modelConfigState.lastRenderedSignature === signature
        && modelConfigState.lastRenderedPage === modelConfigState.page
        && modelConfigState.lastRenderedQuery === modelConfigState.query) return;

    const groups = collectPriceGroups(settings, models);
    const query = modelConfigState.query;
    const matchCount = matchingPriceModels(settings, models, query).length;
    $('#token-usage-bulk-apply')
        .text(query ? `Apply to ${matchCount} matching models` : `Apply to all ${matchCount} models`)
        .prop('disabled', matchCount === 0);
    const filtered = groups.filter(group => !query || group.name.toLowerCase().includes(query)
        || group.models.some(model => model.toLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(filtered.length / modelConfigState.pageSize));
    modelConfigState.page = Math.min(Math.max(1, modelConfigState.page), pages);
    const start = (modelConfigState.page - 1) * modelConfigState.pageSize;
    const pageGroups = filtered.slice(start, start + modelConfigState.pageSize);
    grid.html(pageGroups.length
        ? pageGroups.map(group => renderPriceGroup(group, groups, settings)).join('')
        : '<div class="price-empty">No matching model groups</div>');
    updateModelConfigControls(groups.length, filtered.length,
        start + 1, Math.min(start + pageGroups.length, filtered.length), pages);
    modelConfigState.lastModelCount = models.length;
    modelConfigState.lastRenderedSignature = signature;
    modelConfigState.lastRenderedPage = modelConfigState.page;
    modelConfigState.lastRenderedQuery = query;
    modelConfigState.needsRefresh = false;
}

function renderPriceEditor(key, price, attributes, buttonLabel) {
    const draft = modelConfigPriceDrafts.get(key);
    const value = draft || price || { in: '', out: '' };
    return `<div class="price-editor" data-editor="${escapeHtml(key)}" ${attributes}>
        <label>Input <input type="number" class="price-input-in" min="0" step="any"
            value="${escapeHtml(value.in)}" placeholder="$/1M" aria-label="Input price per million tokens"></label>
        <label>Output <input type="number" class="price-input-out" min="0" step="any"
            value="${escapeHtml(value.out)}" placeholder="$/1M" aria-label="Output price per million tokens"></label>
        <button type="button" class="menu_button price-save">${buttonLabel}</button>
    </div>`;
}

function renderPriceGroup(group, groups, settings) {
    const safeGroup = escapeHtml(group.id);
    const shared = settings.sharedModelPrices?.[group.id];
    const expanded = expandedPriceGroups.has(group.id);
    const overrideCount = group.models.filter(model => Object.hasOwn(settings.modelPrices, model)).length;
    const status = shared ? 'Shared price' : 'Suggested group · no shared price';
    const options = expanded ? groups.filter(other => other.id !== group.id)
        .map(other => `<option value="${escapeHtml(other.id)}">${escapeHtml(other.name)}${other.id.startsWith('exact:') ? ' (separate)' : ''}</option>`).join('') : '';
    const variants = expanded ? group.models.map(model => {
        const safeModel = escapeHtml(model);
        const configured = configuredPrice(settings, model);
        const override = configured?.source === 'Override';
        const price = getModelPrice(model);
        const source = configured?.source || 'Auto / unpriced';
        return `<div class="price-variant">
            <div class="price-variant-heading">
                <input type="color" class="model-color-picker" data-model="${safeModel}"
                    value="${escapeHtml(getModelColor(model))}" aria-label="Chart color for ${safeModel}">
                <span class="price-model-name" title="${safeModel}">${safeModel}</span>
                <span class="price-source">${source}</span>
            </div>
            ${renderPriceEditor('model:' + model, price, `data-model="${safeModel}"`, 'Save override')}
            <div class="price-variant-actions">
                ${override ? `<button type="button" class="menu_button price-inherit" data-model="${safeModel}">${shared ? 'Use shared' : 'Use auto'}</button>` : ''}
                ${options ? `<label>Link to <select class="price-group-link" data-model="${safeModel}" aria-label="Pricing group for ${safeModel}">
                    <option value="">Choose group…</option>${options}</select></label>` : ''}
                ${group.id !== 'exact:' + model ? `<button type="button" class="menu_button price-separate" data-model="${safeModel}">Separate</button>` : ''}
            </div>
        </div>`;
    }).join('') : '';
    return `<section class="price-group">
        <button type="button" class="price-group-toggle" data-group="${safeGroup}" aria-expanded="${expanded}">
            <span aria-hidden="true">${expanded ? '▾' : '▸'}</span>
            <span class="price-model-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
            <span class="price-group-count">${group.models.length} variant${group.models.length === 1 ? '' : 's'}</span>
        </button>
        <div class="price-group-status">${status}${overrideCount ? ` · ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''}</div>
        ${renderPriceEditor('group:' + group.id, shared, `data-group="${safeGroup}"`, 'Save shared')}
        ${shared ? `<button type="button" class="menu_button price-auto" data-group="${safeGroup}">Use automatic pricing</button>` : ''}
        ${expanded ? `<div class="price-variants">${variants || '<div class="price-empty">New matching variants will appear here.</div>'}</div>` : ''}
    </section>`;
}

/** Routes and recent errors shown in the API Errors panel */
const ERROR_PANEL_ROUTE_LIMIT = 25;
const ERROR_PANEL_RECENT_LIMIT = 20;
let errorPanelRenderTimer = null;

/**
 * Clear all recorded API errors and route counts
 */
function clearErrorTracking() {
    getSettings().errorTracking = createErrorStore();
    saveSettings();
    renderErrorPanel();
}

/**
 * @param {object} route
 * @returns {string} Where a route goes: source · endpoint host · provider
 */
function formatRouteWhere(route) {
    return [formatSourceName(route.source), route.host, route.provider].filter(Boolean).join(' · ');
}

/**
 * @param {number} rate Share of failed requests (0-1)
 * @returns {string}
 */
function formatErrorRate(rate) {
    return rate > 0 && rate < 0.01 ? '<1%' : `${Math.round(rate * 100)}%`;
}

/**
 * @param {number} at Timestamp (ms)
 * @returns {string}
 */
function formatErrorTime(at) {
    return Number.isFinite(at) ? _fmtMinute.format(new Date(at)) : '';
}

/**
 * Render the API Errors panel soon, once for a burst of results
 */
function scheduleErrorPanelRender() {
    if (errorPanelRenderTimer) return;
    errorPanelRenderTimer = setTimeout(() => {
        errorPanelRenderTimer = null;
        renderErrorPanel();
    }, 250);
}

/**
 * Update the API Errors count, and the panel's lists while their drawer is open
 * (even when the extensions panel around it is closed, so they are never stale)
 */
function renderErrorPanel() {
    const store = getSettings().errorTracking;
    const routes = erroringRoutes(store);
    const totalErrors = routes.reduce((sum, route) => sum + route.errors, 0);
    $('#token-usage-errors-count').text(totalErrors ? `(${formatCount(totalErrors)})` : '');

    const content = document.getElementById('token-usage-errors-content');
    const body = document.getElementById('token-usage-errors-body');
    if (!content || !body || getComputedStyle(content).display === 'none') return;

    if (!routes.length) {
        body.innerHTML = '<p class="price-empty">No API errors recorded. Chat and text completion errors are listed here by source, endpoint, model and provider.</p>';
        return;
    }

    const routeItems = routes.slice(0, ERROR_PANEL_ROUTE_LIMIT).map(route => {
        const chips = errorBreakdown(route)
            .map(([name, count]) => `<span class="error-chip">${escapeHtml(name)} ×${formatCount(count)}</span>`)
            .join('');
        const last = route.lastError;
        return `
            <li class="error-route">
                <div class="error-route-head">
                    <span class="error-route-model">${escapeHtml(route.model)}</span>
                    <span class="error-route-rate" title="${route.errors} of ${route.attempts} requests failed">${formatCount(route.errors)} / ${formatCount(route.attempts)} · ${formatErrorRate(route.errorRate)}</span>
                </div>
                <div class="error-route-where">${escapeHtml(formatRouteWhere(route))}</div>
                <div class="error-route-chips">${chips}</div>
                ${last ? `<div class="error-route-last" title="${escapeHtml(last.message)}">${escapeHtml(formatErrorTime(last.at))} · ${escapeHtml(last.message)}</div>` : ''}
            </li>`;
    }).join('');
    const hiddenRoutes = routes.length - ERROR_PANEL_ROUTE_LIMIT;

    const recentItems = store.log.slice(-ERROR_PANEL_RECENT_LIMIT).reverse().map(entry => `
        <li title="${escapeHtml(entry.message)}">
            <span class="error-recent-time">${escapeHtml(formatErrorTime(entry.at))}</span>
            <span class="error-chip">${escapeHtml(errorLabel(entry))}</span>
            <span class="error-recent-route">${escapeHtml(entry.model)}${entry.host ? ` @ ${escapeHtml(entry.host)}` : ''}</span>
            <span class="error-recent-message">${escapeHtml(entry.message)}</span>
        </li>`).join('');

    // Keep the recent list open across re-renders
    const recentOpen = body.querySelector('.error-recent')?.open ? ' open' : '';
    const tracked = Object.keys(store.routes).length;
    body.innerHTML = `
        <p class="price-help">${routes.length} of ${tracked} ${tracked === 1 ? 'route' : 'routes'} returned errors. Counts are failed / total requests.</p>
        <ul class="error-routes">${routeItems}</ul>
        ${hiddenRoutes > 0 ? `<p class="price-help">${hiddenRoutes} more: use /tokenerrors for the full list.</p>` : ''}
        <details class="error-recent"${recentOpen}>
            <summary>Recent errors (${store.log.length})</summary>
            <ol>${recentItems}</ol>
        </details>`;
}

/**
 * Create the settings UI in the extensions panel
 */
function createSettingsUI() {
    const settings = getSettings();
    const stats = getUsageStats();

    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div id="token-usage-main-toggle" class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <span id="token-usage-mini-counter" style="margin-left: 8px; font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.75;" title="Today's total tokens">${formatTokens(stats.today.total)}</span>
                    <span id="token-usage-health-indicator" style="margin-left: 6px; font-size: 10px; cursor: help;" title="Extension health status">🟢</span>
                    <button id="token-usage-miniview-toggle" class="menu_button" style="margin-left: 6px; padding: 2px 6px; font-size: 10px;" title="Toggle compact miniview">📊</button>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div id="token-usage-main-content" class="inline-drawer-content">
                    <!-- Chart Header: Today stats + Range/Source selectors -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <div style="display: flex; align-items: baseline; gap: 6px;">
                                <span style="font-size: 18px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-today-total">${formatTokens(stats.today.total)}</span>
                                <span id="token-usage-today-cost" style="font-size: 12px; color: var(--SmartThemeBodyColor); opacity: 0.8;">$0.00</span>
                                <span id="token-usage-range-label" style="font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> today</span>
                            </div>
                            <div id="token-usage-summary-tokens" style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;">
                                <span id="token-usage-today-in">${formatTokens(stats.today.input || 0)}</span> in /
                                <span id="token-usage-today-out">${formatTokens(stats.today.output || 0)}</span> out /
                                <span id="token-usage-today-reasoning">${formatTokens(stats.today.reasoning || 0)}</span> 🧠
                            </div>
                            <div id="token-usage-summary-generations" style="display: none; font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;">
                                <span id="token-usage-summary-stopped">0</span> stopped /
                                <span id="token-usage-summary-failed">0</span> failed<span id="token-usage-summary-attempts-wrap"> /
                                <span id="token-usage-summary-attempts">0</span> attempts</span>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <select id="token-usage-source-filter" style="padding: 4px 8px; font-size: 11px; border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); cursor: pointer;">
                                <option value="all">All Sources</option>
                            </select>
                            <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                                <button class="token-usage-range-btn menu_button" data-value="1" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">1D</button>
                                <button class="token-usage-range-btn menu_button" data-value="7" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">7D</button>
                                <button class="token-usage-range-btn menu_button active" data-value="30" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">30D</button>
                                <button class="token-usage-range-btn menu_button" data-value="90" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">90D</button>
                            </div>
                        </div>
                    </div>

                    <!-- Chart Options -->
                    <div style="display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-bottom: 6px;">
                        <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                            <button class="token-usage-metric-btn menu_button active" data-value="tokens" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">Tokens</button>
                            <button class="token-usage-metric-btn menu_button" data-value="generations" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">Generations</button>
                        </div>
                        <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                            <button class="token-usage-granularity-btn menu_button active" data-value="daily" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">Daily</button>
                            <button class="token-usage-granularity-btn menu_button" data-value="hourly" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">Hourly</button>
                        </div>
                        <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                            <button class="token-usage-charttype-btn menu_button active" data-value="bar" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">📊 Bar</button>
                            <button class="token-usage-charttype-btn menu_button" data-value="line" style="padding: 3px 8px; font-size: 10px; border-radius: 4px;">📈 Line</button>
                        </div>
                    </div>

                    <!-- Chart -->
                    <div id="token-usage-chart" style="width: 100%; height: 320px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden; margin-bottom: 12px;"></div>
                    <div id="token-usage-chart-note" style="display: none; margin: -8px 0 10px; font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Per-source generation counts are only recorded from this version onward; earlier days show 0.</div>

                    <!-- Stats Grid (Week, Month, All Time) -->
                    <div class="token-usage-stats-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px;">
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Week</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-total">${formatTokens(stats.thisWeek.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Month</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-total">${formatTokens(stats.thisMonth.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">All Time</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-total">${formatTokens(stats.allTime.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-cost">$0.00</span>
                            </div>
                        </div>
                    </div>

                    <!-- Efficiency Metrics -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px;">
                        <div style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); padding: 6px 10px;">
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Session Efficiency</div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
                                <div>
                                    <span style="font-size: 13px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-efficiency-ratio">0.00×</span>
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> out/in</span>
                                </div>
                                <div>
                                    <span style="font-size: 13px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-efficiency-permsg">0</span>
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> /gen</span>
                                </div>
                            </div>
                        </div>
                        <div style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); padding: 6px 10px;">
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">All-Time Efficiency</div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
                                <div>
                                    <span style="font-size: 13px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-efficiency-alltime-ratio">0.00×</span>
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> out/in</span>
                                </div>
                                <div>
                                    <span style="font-size: 13px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-efficiency-alltime-permsg">0</span>
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> /gen</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Current Chat Usage -->
                    <div class="inline-drawer" style="margin-bottom: 10px;">
                        <div class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Current Chat</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div id="token-usage-chat-stats" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); padding: 8px 10px;">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                                    <div>
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Total</div>
                                        <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-chat-total">0</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Generations</div>
                                        <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-chat-messages">0</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Input</div>
                                        <div style="font-size: 12px; color: var(--SmartThemeBodyColor);" id="token-usage-chat-input">0</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Output</div>
                                        <div style="font-size: 12px; color: var(--SmartThemeBodyColor);" id="token-usage-chat-output">0</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Cost</div>
                                        <div style="font-size: 12px; color: var(--SmartThemeBodyColor);" id="token-usage-chat-cost">$0.00</div>
                                    </div>
                                </div>
                                <div style="margin-top: 6px; font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-chat-id">No chat active</div>
                            </div>
                        </div>
                    </div>

                    <!-- API Errors by route -->
                    <div class="inline-drawer" style="margin-bottom: 10px;">
                        <div id="token-usage-errors-toggle" class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">API Errors <span id="token-usage-errors-count" class="error-count"></span></span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div id="token-usage-errors-content" class="inline-drawer-content">
                            <div id="token-usage-errors-body"></div>
                            <div class="error-actions">
                                <button id="token-usage-errors-clear" type="button" class="menu_button">Clear errors</button>
                            </div>
                        </div>
                    </div>

                    <!-- Config (Model Colors & Prices) -->
                    <div class="inline-drawer" style="margin-top: 10px;">
                        <div id="token-usage-config-toggle" class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Config</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div id="token-usage-config-content" class="inline-drawer-content">
                            <div id="token-usage-model-config-controls" style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px;">
                                <input id="token-usage-model-search" type="text" placeholder="Search models..." style="flex: 1; min-width: 140px; padding: 3px 6px; font-size: 10px; border-radius: 4px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor);">
                                <div style="display: inline-flex; align-items: center; gap: 4px;">
                                    <button id="token-usage-model-prev" class="menu_button" style="padding: 2px 6px; font-size: 10px;">Prev</button>
                                    <span id="token-usage-model-page-label" style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.7; min-width: 42px; text-align: center;">0 / 0</span>
                                    <button id="token-usage-model-next" class="menu_button" style="padding: 2px 6px; font-size: 10px;">Next</button>
                                </div>
                            </div>
                            <div id="token-usage-bulk-pricing" class="price-editor">
                                <label>Input $/1M <input id="token-usage-bulk-in" type="number" min="0" step="any" placeholder="Input price" aria-label="Bulk input price per million tokens"></label>
                                <label>Output $/1M <input id="token-usage-bulk-out" type="number" min="0" step="any" placeholder="Output price" aria-label="Bulk output price per million tokens"></label>
                                <button id="token-usage-bulk-apply" type="button" class="menu_button" disabled>Apply to matching models</button>
                            </div>
                            <p class="price-help">Apply updates every model ID matching your search across all pages, including existing overrides. An empty search updates all models.</p>
                            <p class="price-help">For ongoing shared pricing, save a group's shared price below. Expand a model to override or link variants.</p>
                            <p class="price-help">On first save, identical existing prices inherit the shared price; different prices stay as overrides. Search filters groups, not which variants share the price.</p>
                            <div id="token-usage-model-summary" style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.55; margin-bottom: 6px;">No models tracked yet</div>
                            <div id="token-usage-model-colors-grid"></div>
                        </div>
                    </div>

                    <!-- Controls -->
                    <div style="display: flex; align-items: center; gap: 8px; padding-left: 8px;">
                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-tokenizer">Tokenizer: ${stats.tokenizer || 'Unknown'}</div>
                        <div style="flex: 1;"></div>
                        <div id="token-usage-reset-all" class="menu_button" title="Reset all stats" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-trash"></i>&nbsp;Reset All
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const targetContainer = $('#extensions_settings2');
    if (targetContainer.length > 0) {
        targetContainer.append(html);
        console.log('[Token Usage Tracker] UI appended to extensions_settings2');
    } else {
        const fallback = $('#extensions_settings');
        if (fallback.length > 0) {
            fallback.append(html);
            console.log('[Token Usage Tracker] UI appended to extensions_settings (fallback)');
        }
    }

    // Create tooltip element and append to body (not inside extension container to avoid layout issues)
    if (!document.getElementById('token-usage-tooltip')) {
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.9); color: white; padding: 8px 12px; border-radius: 6px; font-size: 11px; pointer-events: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(tooltipEl);
        console.log('[Token Usage Tracker] Tooltip appended to body');
    }
    tooltip = document.getElementById('token-usage-tooltip');

    // Initialize chart
    chartData = getChartDataForGranularity();
    setTimeout(renderChartByType, 100);

    // Initialize source dropdown
    updateSourceDropdown();

    // Initialize model config controls and lazy rendering
    $('#token-usage-model-search').val(modelConfigState.query);
    updateModelConfigControls(0, 0, 0, 0, 0);
    bindModelConfigControls();
    observeModelConfigVisibility();

    const syncConfigAfterToggle = () => {
        setTimeout(() => syncModelConfigVisibility(true), 0);
    };
    $('#token-usage-main-toggle').on('click', syncConfigAfterToggle);
    $('#token-usage-config-toggle').on('click', syncConfigAfterToggle);
    syncModelConfigVisibility(true);

    // API errors: the lists render only while their drawer is open, so render when it opens
    $('#token-usage-errors-toggle').on('click', () => setTimeout(renderErrorPanel, 0));
    $('#token-usage-errors-clear').on('click', () => {
        if (confirm('Clear all recorded API errors and route counts?')) {
            clearErrorTracking();
            toastr.success('API errors cleared');
        }
    });
    renderErrorPanel();

    // Range button handlers
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
        });
    });

    // Chart metric button handlers
    document.querySelectorAll('.token-usage-metric-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentChartMetric = btn.getAttribute('data-value');
            document.querySelectorAll('.token-usage-metric-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chartData = getChartDataForGranularity();
            renderChartByType();
            updateRangeSummary();
        });
    });

    // Granularity button handlers
    document.querySelectorAll('.token-usage-granularity-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = btn.getAttribute('data-value');
            currentGranularity = value;
            document.querySelectorAll('.token-usage-granularity-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chartData = getChartDataForGranularity();
            renderChartByType();
        });
    });

    // Chart type button handlers
    document.querySelectorAll('.token-usage-charttype-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = btn.getAttribute('data-value');
            currentChartType = value;
            document.querySelectorAll('.token-usage-charttype-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderChartByType();
        });
    });

    // Source filter dropdown handler
    $('#token-usage-source-filter').on('change', function () {
        updateSourceFilter($(this).val());
    });

    $('#token-usage-reset-all').on('click', function () {
        if (confirm('Are you sure you want to reset ALL token usage data? This cannot be undone.')) {
            resetAllUsage();
            updateUIStats();
            toastr.success('All stats reset');
        }
    });

    // Miniview toggle button handler
    $('#token-usage-miniview-toggle').on('click', function (e) {
        e.stopPropagation(); // Prevent triggering the drawer toggle
        toggleMiniview();
    });

    // Create miniview (will show if pinned)
    createMiniview();

    // Subscribe to updates
    eventSource.on('tokenUsageUpdated', updateUIStats);

    setTimeout(updateUIStats, 0);

    // Handle container resize with ResizeObserver (handles panel width changes)
    const chartContainer = document.getElementById('token-usage-chart');
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
        let lastWidth = 0;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                // Only re-render if width actually changed
                if (Math.abs(newWidth - lastWidth) > 20) {
                    lastWidth = newWidth;
                    renderChartByType();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }

    // Bus/fallback resize wiring (prevent duplicate global listeners)
    if (resizeBusUnsubscribe) {
        resizeBusUnsubscribe();
        resizeBusUnsubscribe = null;
    }
    if (resizeAbortController) resizeAbortController.abort();
    resizeAbortController = new AbortController();
    let resizeTimeout;
    let lastResizeWidth = 0;
    let lastResizeHeight = 0;
    const onViewportResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const currentWidth = window.innerWidth;
            const currentHeight = window.innerHeight;
            const widthChanged = Math.abs(currentWidth - lastResizeWidth) >= 20;
            const heightChanged = Math.abs(currentHeight - lastResizeHeight) >= 20;

            // Skip entirely on keyboard open/close (height-only change)
            if (!widthChanged && heightChanged) {
                lastResizeHeight = currentHeight;
                return;
            }

            if (widthChanged) {
                lastResizeWidth = currentWidth;
                lastResizeHeight = currentHeight;
                renderChartByType();
            }
            // Only reposition miniview on width changes
            debouncedMiniviewResize();
        }, 250);
    };

    const runtimeBus = window.STRuntimeBus;
    if (runtimeBus?.viewport?.subscribe) {
        resizeBusUnsubscribe = runtimeBus.viewport.subscribe('layout', onViewportResize);
    } else {
        window.addEventListener('resize', onViewportResize, { signal: resizeAbortController.signal });
    }
}

/**
 * Set up tracking for background generations:
 * - Generation requests (including quiet ones: Summarize, Expressions, etc.) via a fetch observer
 * - ConnectionManagerRequestService.sendRequest (Roadway, Scratch Pad, etc.) via function wrapping
 */
let resizeAbortController = null;
let resizeBusUnsubscribe = null;

function patchBackgroundGenerations() {
    installGenerationRequestObserver();
    patchConnectionManager();
}

/**
 * Record the oldest open quiet generation now, optionally with caller-provided output text.
 * Returns false when no quiet generation is pending (it was already recorded).
 * @param {string} [outputText]
 * @returns {Promise<boolean>}
 */
async function flushPendingQuietGeneration(outputText = '') {
    const attempt = attemptTracker.oldestOpen('quiet');
    if (!attempt) return false;

    attemptTracker.resolve(attempt, 'succeeded', { text: typeof outputText === 'string' ? outputText : '' });
    await attempt.recording;
    return true;
}

/** SillyTavern backend endpoints that perform one text generation request */
const GENERATION_REQUEST_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/backends/koboldhorde/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
]);

/** Unique symbol to mark fetch as observed by this extension. */
const TOKEN_USAGE_FETCH_PATCHED = Symbol.for('tokenUsageTrackerFetchPatched');

/**
 * Observe generation requests to learn whether each attempt reached the API and how it ended,
 * and which routes (source, endpoint, model, provider) return errors.
 * The request itself and the caller's Response are never modified.
 */
function installGenerationRequestObserver() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function' || originalFetch[TOKEN_USAGE_FETCH_PATCHED]) return;

    const observedFetch = function (input, init) {
        let observation = null;
        try {
            observation = observeGenerationRequest(input, init);
        } catch (error) {
            console.error('[Token Usage Tracker] Error observing generation request:', error);
        }

        const request = originalFetch.apply(this, arguments);
        if (observation) {
            observeGenerationResponse(observation, request);
        }
        return request;
    };
    observedFetch[TOKEN_USAGE_FETCH_PATCHED] = true;
    window.fetch = observedFetch;
}

/**
 * Bind a generation request to the oldest attempt still waiting for one and identify its route.
 * Requests with no attempt (Connection Manager profiles, connection tests) still have a route.
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @returns {{attempt: object|null, route: object|null, streaming: boolean, signal: AbortSignal|null, genType: string}|null}
 */
function observeGenerationRequest(input, init) {
    const url = input instanceof URL ? input.href : (typeof input === 'string' ? input : input?.url);
    if (!url) return null;
    const path = new URL(url, window.location.origin).pathname;
    if (!GENERATION_REQUEST_PATHS.has(path)) return null;

    // An already-aborted request belongs to a generation that was stopped before sending
    const signal = init?.signal ?? input?.signal ?? null;
    if (signal?.aborted) return null;

    const body = parseRequestBody(init?.body);
    const streaming = body?.stream === true || body?.streaming === true;
    const attempt = attemptTracker.bindRequest({ streaming });
    // SillyTavern creates the streaming processor just before sending a streaming request
    if (attempt?.kind === 'main' && attempt.streaming) {
        attempt.meta.streamingProcessor = streamingProcessor;
    }
    const route = routeFromRequest(path, body);
    if (!attempt && !route) return null;
    return { attempt, route, streaming, signal, genType: attempt?.meta.genType || '' };
}

/**
 * @param {any} body - Request body
 * @returns {any} The parsed JSON body, or null
 */
function parseRequestBody(body) {
    if (typeof body !== 'string') return null;
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

/**
 * Whether a request or its body failed because it was aborted. SillyTavern often
 * aborts with a reason, which rejects with that reason instead of an AbortError.
 * @param {{signal: AbortSignal|null}} observation
 * @param {any} error
 * @returns {boolean}
 */
function isAbortedRequest(observation, error) {
    const signal = observation.signal;
    return error?.name === 'AbortError' || (signal?.aborted === true && error === signal.reason);
}

/**
 * Settle an attempt and record the route's result from the request's response.
 * Registered before the caller's own handlers, so the response can still be
 * cloned before the caller reads its body.
 * @param {{attempt: object|null, route: object|null, streaming: boolean, signal: AbortSignal|null}} observation
 * @param {Promise<Response>} request
 */
function observeGenerationResponse(observation, request) {
    const { attempt, route, streaming } = observation;
    request.then(
        (response) => {
            if (!response.ok) {
                attemptTracker.requestSettled(attempt, 'failed');
                return route && recordHttpError(observation, response.clone());
            }
            attemptTracker.requestSettled(attempt, 'ok');
            if (streaming) {
                return route && watchStreamedResponse(observation, response.clone());
            }
            return inspectResponse(observation, response.clone());
        },
        (error) => {
            const aborted = isAbortedRequest(observation, error);
            attemptTracker.requestSettled(attempt, aborted ? 'aborted' : 'failed');
            if (route && !aborted) {
                recordRouteResult(observation, { kind: 'network', message: error?.message || String(error) });
            }
        },
    ).catch(error => {
        console.error('[Token Usage Tracker] Error observing generation response:', error);
    });
}

/**
 * Read a (cloned) non-streaming response. An error payload, which OpenAI-compatible
 * sources return with HTTP 200, fails the attempt: it gets no message event.
 * Quiet generations emit no event on success, so the response resolves them.
 * @param {{attempt: object|null, route: object|null}} observation
 * @param {Response} response
 */
async function inspectResponse(observation, response) {
    const { attempt, route } = observation;
    let data = null;
    try {
        data = await response.json();
    } catch {
        // Not JSON: count the generation without output text
    }

    const error = payloadError(data);
    if (route) {
        const routeError = error && { kind: 'response', status: statusFromReason(error.message), ...error };
        recordRouteResult(observation, routeError, payloadProvider(data));
    }
    if (error) {
        attemptTracker.resolve(attempt, 'failed');
    } else if (attempt?.kind === 'quiet') {
        attemptTracker.resolve(attempt, 'succeeded', { responseData: data });
    }
}

/**
 * Record a (cloned) HTTP error response against its route
 * @param {{route: object}} observation
 * @param {Response} response
 */
async function recordHttpError(observation, response) {
    let body = '';
    try {
        body = await response.text();
    } catch {
        // Body unavailable: the status is enough
    }
    let data = body;
    try {
        data = JSON.parse(body);
    } catch {
        // Plain text or an HTML error page
    }
    const error = { kind: 'http', status: response.status, ...describeError(data, response.statusText) };
    recordRouteResult(observation, error, payloadProvider(data));
}

/**
 * Read a (cloned) streamed response alongside SillyTavern. SillyTavern only shows a toast
 * for an error event and then ends the stream like a successful one, so the error is
 * recorded here and fails the attempt.
 * @param {{attempt: object|null, route: object, signal: AbortSignal|null}} observation
 * @param {Response} response
 */
async function watchStreamedResponse(observation, response) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const scanner = createStreamScanner();
    const decoder = new TextDecoder();
    let error = null;
    try {
        while (!error) {
            const { done, value } = await reader.read();
            const errors = done
                ? [...scanner.push(decoder.decode()), ...scanner.finish()]
                : scanner.push(decoder.decode(value, { stream: true }));
            if (errors.length) error = { kind: 'stream', ...errors[0] };
            if (done) break;
        }
    } catch (readError) {
        if (!isAbortedRequest(observation, readError)) {
            error = { kind: 'interrupted', message: readError?.message || String(readError) };
        } else {
            // SillyTavern aborts a stream it failed to read (onErrorStreaming), possibly before
            // this copy reached the failing event; any other abort is a user stop
            const sp = observation.attempt?.meta.streamingProcessor;
            if (!(sp?.isStopped === true && sp.isFinished !== true)) return;
            error = { kind: 'stream', message: 'SillyTavern could not read the stream' };
        }
    }
    // Stop buffering the rest of this copy of the stream
    if (error) reader.cancel().catch(() => {});

    recordRouteResult(observation, error, scanner.provider);
    if (error) attemptTracker.resolve(observation.attempt, 'failed');
}

/**
 * Record how a request to a route ended
 * @param {{route: object, genType?: string}} observation
 * @param {object|null} error null for success
 * @param {string} [provider] Upstream provider named by the response
 */
function recordRouteResult({ route, genType }, error, provider = '') {
    recordRouteOutcome(getSettings().errorTracking, provider ? { ...route, provider } : route, error, {
        now: getCurrentEasternTime().getTime(),
        genType: genType || '',
    });
    saveSettings();
    if (error) {
        console.warn(`[Token Usage Tracker] API error (${errorLabel(error)}) from ${route.model} via ${route.source}${route.host ? ` @ ${route.host}` : ''}: ${error.message}`);
    }
    scheduleErrorPanelRender();
}

/** Unique symbol to mark sendRequest as patched by this extension. */
const TOKEN_USAGE_PATCHED = Symbol.for('tokenUsageTrackerPatched');

function patchConnectionManager() {
    // Try immediately — Connection Manager may already be loaded
    if (tryPatchSendRequest()) return;

    // Otherwise wait for APP_READY (fires after all extensions load)
    const onReady = () => {
        if (!tryPatchSendRequest()) {
            console.warn('[Token Usage Tracker] ConnectionManagerRequestService not available — connection profile calls will not be tracked');
        }
    };

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, onReady);
    } else {
        // Fallback for older ST versions without APP_READY
        setTimeout(onReady, 3000);
    }
}

function tryPatchSendRequest() {
    try {
        const context = getContext();
        const ServiceClass = context?.ConnectionManagerRequestService;
        if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return false;
        if (ServiceClass.sendRequest[TOKEN_USAGE_PATCHED]) return true; // Already patched by us

        const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

        ServiceClass.sendRequest = async function (profileId, messages, maxTokens, custom, overridePayload) {
            // Best-effort: captures the globally-selected model/source at call time.
            // May not reflect the actual model used if the extension overrides it.
            const modelId = getCurrentModelId();
            const sourceId = getCurrentSourceId();

            // State is per call so concurrent requests are each tracked
            const inputTokensPromise = countInputTokens({ prompt: messages }).catch(e => {
                console.error('[Token Usage Tracker] Error counting sendRequest input:', e);
                return 0;
            });

            let result;
            try {
                result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
            } catch (error) {
                inputTokensPromise.then(inputTokens => {
                    if (error?.name === 'AbortError') {
                        recordUsage(inputTokens, 0, null, modelId, sourceId, 0, 'stopped');
                    } else {
                        recordFailedAttempt(null, modelId, sourceId);
                    }
                }).catch(e => console.error('[Token Usage Tracker] Error recording sendRequest failure:', e));
                throw error;
            }

            try {
                const inputTokens = await inputTokensPromise;
                let outputTokens = 0;
                if (result && typeof result.content === 'string') {
                    outputTokens = await countTokens(result.content);
                } else if (typeof result === 'string') {
                    outputTokens = await countTokens(result);
                }

                if (outputTokens > 0 || inputTokens > 0) {
                    recordUsage(inputTokens, outputTokens, null, modelId, sourceId);
                }
            } catch (e) {
                console.error('[Token Usage Tracker] Error counting sendRequest output:', e);
            }

            return result;
        };

        ServiceClass.sendRequest[TOKEN_USAGE_PATCHED] = true;
        console.log('[Token Usage Tracker] Patched ConnectionManagerRequestService.sendRequest');
        return true;
    } catch (e) {
        console.error('[Token Usage Tracker] Error in tryPatchSendRequest:', e);
        return false;
    }
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Sync time with external source in background (non-blocking so UI appears immediately)
    syncTimeOffset().then((success) => {
        if (success) {
            console.log('[Token Usage Tracker] External time sync successful');
        } else {
            console.log('[Token Usage Tracker] Using local time with Eastern timezone conversion');
        }
    });

    // Auto-fetch OpenRouter pricing if using OpenRouter API
    maybeAutoFetchOpenRouterPricing();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);
    if (event_types.GENERATION_ENDED) {
        // First, so a streaming error is read before other listeners yield
        if (typeof eventSource.makeFirst === 'function') {
            eventSource.makeFirst(event_types.GENERATION_ENDED, handleGenerationEnded);
        } else {
            eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);
        }
    }

    // Log current tokenizer
    try {
        const { tokenizerName } = getFriendlyTokenizerName(main_api);
        console.log(`[Token Usage Tracker] Using tokenizer: ${tokenizerName}`);
    } catch (e) {
        console.log('[Token Usage Tracker] Tokenizer will be determined when API is connected');
    }

    console.log('[Token Usage Tracker] Use /tokenusage to see stats, /tokenreset to reset session');

    // Emit initial stats for any listening UI
    setTimeout(() => {
        eventSource.emit('tokenUsageUpdated', getUsageStats());
    }, 1000);
});
