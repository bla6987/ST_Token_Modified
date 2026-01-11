/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting (non-blocking)
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getFriendlyTokenizerName } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { getChatCompletionModel, oai_settings } from '../../../openai.js';
import { textgenerationwebui_settings as textgen_settings } from '../../../textgen-settings.js';

const extensionName = 'token-usage-tracker';

const EASTERN_TIMEZONE = 'America/New_York';
let externalTimeOffset = null; // Offset between local time and external time (in ms)
let lastTimeSyncTimestamp = null;
const TIME_SYNC_INTERVAL = 5 * 60 * 1000; // Re-sync every 5 minutes

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
        const response = await fetch(`https://worldtimeapi.org/api/timezone/${EASTERN_TIMEZONE}`);
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
    // Miniview settings
    miniview: {
        pinned: false,
        mode: 'session', // 'session', 'hourly', 'daily'
        position: { bottom: 80, right: 20 }, // Position in pixels
        size: { width: 180, height: null }, // Size in pixels (null = auto height)
    },
    // Accumulated usage data
    usage: {
        session: { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, startTime: null },
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
    },
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

    // Initialize modelPrices
    if (!settings.modelPrices) settings.modelPrices = {};

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

    // Initialize session start time
    if (!settings.usage.session.startTime) {
        settings.usage.session.startTime = getCurrentEasternTime().toISOString();
    }

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
 * Get the current week key (YYYY-WNN)
 */
function getWeekKey(date = getCurrentEasternTime()) {
    const { year, month, day } = getEasternParts(date);
    // Week calculation is based on the Eastern calendar date, but done in UTC for consistency.
    const easternCalendarDateUtc = new Date(Date.UTC(year, month - 1, day));
    const startOfYearUtc = new Date(Date.UTC(year, 0, 1));
    const days = Math.floor((easternCalendarDateUtc.getTime() - startOfYearUtc.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYearUtc.getUTCDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
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

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response (excluding reasoning)
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 * @param {string} [sourceId] - Optional source ID for per-source tracking
 * @param {number} [reasoningTokens] - Optional reasoning/thinking tokens (Claude, o1, etc.)
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null, sourceId = null, reasoningTokens = 0) {
    const settings = getSettings();
    const usage = settings.usage;
    const now = getCurrentEasternTime();
    const totalTokens = inputTokens + outputTokens + reasoningTokens;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.reasoning = (bucket.reasoning || 0) + reasoningTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
    };

    // Session
    addTokens(usage.session);

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, total: 0, messageCount: 0, models: {}, sources: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown for cost calculation)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, total: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
    }

    // Track source within day for filtering
    if (sourceId) {
        if (!usage.byDay[dayKey].sources) usage.byDay[dayKey].sources = {};
        if (!usage.byDay[dayKey].sources[sourceId]) {
            usage.byDay[dayKey].sources[sourceId] = { input: 0, output: 0, total: 0, models: {} };
        }
        const sourceData = usage.byDay[dayKey].sources[sourceId];
        sourceData.input += inputTokens;
        sourceData.output += outputTokens;
        sourceData.total += totalTokens;

        // Also track model within source for the day (for filtered chart stacking)
        if (modelId) {
            if (!sourceData.models) sourceData.models = {};
            if (!sourceData.models[modelId]) {
                sourceData.models[modelId] = { input: 0, output: 0, total: 0 };
            }
            sourceData.models[modelId].input += inputTokens;
            sourceData.models[modelId].output += outputTokens;
            sourceData.models[modelId].total += totalTokens;
        }
    }

    // By hour
    const hourKey = getHourKey(now);
    if (!usage.byHour[hourKey]) usage.byHour[hourKey] = { input: 0, output: 0, reasoning: 0, total: 0, messageCount: 0, models: {}, sources: {} };
    addTokens(usage.byHour[hourKey]);

    // Track model within hour for cost calculation
    if (modelId) {
        if (!usage.byHour[hourKey].models) usage.byHour[hourKey].models = {};
        if (!usage.byHour[hourKey].models[modelId]) {
            usage.byHour[hourKey].models[modelId] = { input: 0, output: 0, total: 0 };
        }
        const hourModelData = usage.byHour[hourKey].models[modelId];
        hourModelData.input += inputTokens;
        hourModelData.output += outputTokens;
        hourModelData.total += totalTokens;
    }

    // Track source within hour for filtering
    if (sourceId) {
        if (!usage.byHour[hourKey].sources) usage.byHour[hourKey].sources = {};
        if (!usage.byHour[hourKey].sources[sourceId]) {
            usage.byHour[hourKey].sources[sourceId] = { input: 0, output: 0, total: 0 };
        }
        const hourSourceData = usage.byHour[hourKey].sources[sourceId];
        hourSourceData.input += inputTokens;
        hourSourceData.output += outputTokens;
        hourSourceData.total += totalTokens;
    }

    // By week
    const weekKey = getWeekKey(now);
    if (!usage.byWeek[weekKey]) usage.byWeek[weekKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byWeek[weekKey]);

    // By month
    const monthKey = getMonthKey(now);
    if (!usage.byMonth[monthKey]) usage.byMonth[monthKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byMonth[monthKey]);

    // By chat
    if (chatId) {
        if (!usage.byChat[chatId]) usage.byChat[chatId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byChat[chatId]);
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    // By source (aggregate)
    if (sourceId) {
        if (!usage.bySource[sourceId]) usage.bySource[sourceId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.bySource[sourceId]);
    }

    saveSettings();

    // Update health tracking timestamp
    lastRecordedTimestamp = getCurrentEasternTime().toISOString();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'}, source: ${sourceId || 'unknown'} (using ${getFriendlyTokenizerName(main_api).tokenizerName})`);
}

/**
 * Reset session usage
 */
function resetSession() {
    const settings = getSettings();
    settings.usage.session = {
        input: 0,
        output: 0,
        total: 0,
        messageCount: 0,
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

/** @type {Promise<number>|null} Promise that resolves to input token count - started early, awaited later */
let pendingInputTokensPromise = null;
let pendingModelId = null;
let pendingSourceId = null;
// For 'continue' type generations, track the pre-continue token count so we can compute the delta
let preContinueTokenCount = 0;

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
 * Handle GENERATE_AFTER_DATA event - start counting input tokens (non-blocking)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    // Capture model ID and source ID synchronously (fast)
    pendingModelId = getCurrentModelId();
    pendingSourceId = getCurrentSourceId();

    // Start token counting but DON'T await - let it run in parallel with the API request
    pendingInputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${pendingModelId}, source: ${pendingSourceId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
let isQuietGeneration = false;
let isImpersonateGeneration = false;

function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Track the generation type for special handling
    isQuietGeneration = (type === 'quiet');
    isImpersonateGeneration = (type === 'impersonate');

    // Reset pre-continue state
    preContinueTokenCount = 0;

    // For continue type, capture the current message's token count
    // IMPORTANT: Do NOT await here - this handler must be non-blocking to avoid freezing the UI
    if (type === 'continue') {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available (synchronous - fast path)
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    preContinueTokenCount = lastMessage.extra.token_count;
                } else {
                    // Calculate it ourselves - schedule async but don't block
                    // We use a promise to capture the count before message handling needs it
                    (async () => {
                        try {
                            let tokens = await countTokens(lastMessage.mes || '');
                            if (lastMessage.extra?.reasoning) {
                                tokens += await countTokens(lastMessage.extra.reasoning);
                            }
                            preContinueTokenCount = tokens;
                        } catch (error) {
                            console.error('[Token Usage Tracker] Error calculating pre-continue tokens:', error);
                            preContinueTokenCount = 0;
                        }
                    })();
                }
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            preContinueTokenCount = 0;
        }
    }
}

/**
 * Handle message received event - count output tokens and record
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning)
 * Falls back to manual counting if not available
 *
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
async function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    // These events are emitted for messages created without calling the API
    const nonApiTypes = ['command', 'first_message'];
    if (nonApiTypes.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // If there's no pending token counting promise, this likely isn't a real API response
    // (e.g., could be a late-firing event after chat load)
    if (!pendingInputTokensPromise) {
        console.log(`[Token Usage Tracker] Skipping message with no pending token count (type: ${type || 'unknown'})`);
        return;
    }

    try {
        const context = getContext();
        const message = context.chat[messageIndex];

        if (!message || !message.mes) return;

        let outputTokens;
        let reasoningTokens = 0;

        // Count reasoning/thinking tokens separately (from Claude thinking, OpenAI o1, etc.)
        if (message.extra?.reasoning) {
            reasoningTokens = await countTokens(message.extra.reasoning);
            console.log(`[Token Usage Tracker] Counted ${reasoningTokens} reasoning/thinking tokens`);
        }

        // Use SillyTavern's pre-calculated token count if available
        // Note: This may include reasoning tokens, so we subtract them to get just response tokens
        if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
            outputTokens = message.extra.token_count;
            // If reasoning tokens exist and are included in token_count, subtract them
            // We track them separately for more accurate breakdown
            if (reasoningTokens > 0 && message.extra.token_count > reasoningTokens) {
                outputTokens = message.extra.token_count - reasoningTokens;
            }
            console.log(`[Token Usage Tracker] Token count: ${outputTokens} response + ${reasoningTokens} reasoning`);
        } else {
            // Fall back to manual counting (just the message, not reasoning)
            outputTokens = await countTokens(message.mes);
            console.log(`[Token Usage Tracker] Manually counted: ${outputTokens} response + ${reasoningTokens} reasoning`);
        }

        // For 'continue' type, we only want the newly generated tokens, not the full message
        // Subtract the pre-continue token count to get just the delta
        if (type === 'continue' && preContinueTokenCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = preContinueTokenCount;
        preContinueTokenCount = 0;

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        const sourceId = pendingSourceId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        pendingSourceId = null;

        const chatId = getCurrentChatId();

        recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, reasoningTokens);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${outputTokens} out, ${reasoningTokens} reasoning, model: ${modelId || 'unknown'}, source: ${sourceId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting output tokens:', error);
    }
}

/**
 * Handle generation stopped event - count tokens for cancelled/stopped generations
 * This ensures that input tokens (which were sent to the API) are still counted,
 * along with any partial output tokens that were generated before stopping.
 */
async function handleGenerationStopped() {
    // If there's no pending token counting promise, nothing to record
    if (!pendingInputTokensPromise) return;

    try {
        let outputTokens = 0;

        // Try to get partial output from the streaming processor
        if (streamingProcessor) {
            // Count main response text
            if (streamingProcessor.result) {
                outputTokens = await countTokens(streamingProcessor.result);
                console.log(`[Token Usage Tracker] Partial output from stopped generation: ${outputTokens} tokens`);
            }

            // Also count any reasoning tokens that were generated
            if (streamingProcessor.reasoningHandler?.reasoning) {
                const reasoningTokens = await countTokens(streamingProcessor.reasoningHandler.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} partial reasoning tokens`);
            }
        }

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        const sourceId = pendingSourceId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        pendingSourceId = null;
        preContinueTokenCount = 0; // Reset continue state too

        const chatId = getCurrentChatId();

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${inputTokens} in, ${outputTokens} out (partial), model: ${modelId || 'unknown'}, source: ${sourceId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingInputTokensPromise = null;
        preContinueTokenCount = 0;
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingInputTokensPromise = null;
    pendingModelId = null;
    pendingSourceId = null;
    preContinueTokenCount = 0;
    isQuietGeneration = false;
    isImpersonateGeneration = false;
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit('tokenUsageUpdated', getUsageStats());
}

/**
 * Handle impersonate ready event - count output tokens for impersonation
 * This fires when impersonation completes and puts text into the input field
 * @param {string} text - The generated impersonation text
 */
async function handleImpersonateReady(text) {
    if (!pendingInputTokensPromise) return;

    try {

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        const sourceId = pendingSourceId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        pendingSourceId = null;

        // Count output tokens from the impersonated text
        let outputTokens = 0;
        if (text && typeof text === 'string') {
            outputTokens = await countTokens(text);
        }

        const chatId = getCurrentChatId();

        recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId);


        // Reset impersonate state
        isImpersonateGeneration = false;
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling impersonate ready:', error);
        pendingInputTokensPromise = null;
        pendingModelId = null;
        pendingSourceId = null;
        isImpersonateGeneration = false;
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
            return [
                `**Today's Token Usage:**`,
                `Total: ${formatNumberFull(stats.today.total)} tokens`,
                `Input: ${formatNumberFull(stats.today.input || 0)} tokens`,
                `Output: ${formatNumberFull(stats.today.output || 0)} tokens`,
                `Messages: ${stats.today.messageCount || 0}`,
                `Efficiency: ${efficiency.ratio.toFixed(2)}× out/in, ${formatTokens(efficiency.perMessage)}/msg`,
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
                `Messages: ${chatUsage.messageCount}`,
                `Efficiency: ${efficiency.ratio.toFixed(2)}× out/in, ${formatTokens(efficiency.perMessage)}/msg`,
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
    countTokens, // Expose the token counting function
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
 * @param {string} modelId
 * @returns {{in: number, out: number}} Price per 1M tokens
 */
function getModelPrice(modelId) {
    const settings = getSettings();
    return settings.modelPrices[modelId] || { in: 0, out: 0 };
}

/**
 * Set price settings for a model
 * @param {string} modelId
 * @param {number} priceIn - Price per 1M input tokens
 * @param {number} priceOut - Price per 1M output tokens
 */
function setModelPrice(modelId, priceIn, priceOut) {
    const settings = getSettings();
    settings.modelPrices[modelId] = {
        in: parseFloat(priceIn) || 0,
        out: parseFloat(priceOut) || 0
    };
    saveSettings();
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
        version: '1.0',
        exportDate: getCurrentEasternTime().toISOString(),
        extensionName: extensionName,
        usage: settings.usage,
        modelPrices: settings.modelPrices,
        modelColors: settings.modelColors
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

    const settings = getSettings();

    // Import usage data (merge with existing)
    if (data.usage.session) {
        // Don't import session data - it's ephemeral
    }

    // Merge byDay data
    if (data.usage.byDay) {
        for (const [dayKey, dayData] of Object.entries(data.usage.byDay)) {
            if (!settings.usage.byDay[dayKey]) {
                settings.usage.byDay[dayKey] = dayData;
            } else {
                // Merge: add tokens if day already exists
                settings.usage.byDay[dayKey].input += dayData.input || 0;
                settings.usage.byDay[dayKey].output += dayData.output || 0;
                settings.usage.byDay[dayKey].total += dayData.total || 0;
                settings.usage.byDay[dayKey].messageCount += dayData.messageCount || 0;
            }
        }
    }

    // Merge byHour data
    if (data.usage.byHour) {
        for (const [hourKey, hourData] of Object.entries(data.usage.byHour)) {
            if (!settings.usage.byHour[hourKey]) {
                settings.usage.byHour[hourKey] = hourData;
            } else {
                settings.usage.byHour[hourKey].input += hourData.input || 0;
                settings.usage.byHour[hourKey].output += hourData.output || 0;
                settings.usage.byHour[hourKey].total += hourData.total || 0;
                settings.usage.byHour[hourKey].messageCount += hourData.messageCount || 0;
            }
        }
    }

    // Merge model prices (overwrite existing)
    if (data.modelPrices) {
        Object.assign(settings.modelPrices, data.modelPrices);
    }

    // Merge model colors (overwrite existing)
    if (data.modelColors) {
        Object.assign(settings.modelColors, data.modelColors);
    }

    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    return {
        success: true,
        message: `Import successful. Merged data from ${data.exportDate || 'unknown date'}.`
    };
}

// Chart state
let currentChartRange = 30;
let currentSourceFilter = 'all'; // 'all' or specific source ID like 'openai', 'textgenerationwebui'
let currentChartType = 'bar'; // 'bar' or 'line'
let currentGranularity = 'daily'; // 'daily' or 'hourly'
let chartData = [];
let tooltip = null;

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

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
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

        data.push({
            date: date,
            dayKey: dayKey,
            usage: usage,
            input: input,
            output: output,
            models: models,
            displayDate: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date)
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

    for (let i = hours - 1; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hourKey = getHourKey(date);
        const hourData = byHour[hourKey] || { total: 0, input: 0, output: 0, messageCount: 0 };

        // For hourly data, we don't have per-source breakdown at hour level currently
        // Use the raw hourly data
        data.push({
            date: date,
            hourKey: hourKey,
            usage: hourData.total || 0,
            input: hourData.input || 0,
            output: hourData.output || 0,
            models: {},
            displayDate: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, hour: 'numeric', hour12: true }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', hour12: true }).format(date)
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
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

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
        text.textContent = formatTokens(val);
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
        cursor.addEventListener('mousemove', (e) => {
            moveTooltip(e);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${barWidth} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${barWidth - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        if (d.models && Object.keys(d.models).length > 0 && d.usage > 0) {
            // Extract total from new object format or use number directly for legacy
            const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
            const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1])); // Sort by usage desc

            let cumulativeY = barY + h; // Start from bottom

            for (const [modelId, modelData] of modelEntries) {
                const tokens = getTokens(modelData);
                const segmentHeight = (tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${barWidth} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${barWidth - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${barWidth - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${barWidth} v${segmentHeight} z`;
                }

                const color = getModelColor(modelId);
                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: '1',
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
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

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
        text.textContent = formatTokens(val);
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
        dot.addEventListener('mousemove', (e) => {
            moveTooltip(e);
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

    // Build model breakdown HTML
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
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatTokens(tokens)} (${percent}%)</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} tokens</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.input)} in / ${formatNumberFull(d.output)} out</div>
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

function moveTooltip(e) {
    if (!tooltip) return;

    const tooltipWidth = tooltip.offsetWidth || 150;
    const tooltipHeight = tooltip.offsetHeight || 60;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = e.clientX + 15;
    let y = e.clientY - 10;

    // Keep tooltip within viewport
    if (x + tooltipWidth > viewportWidth - 10) {
        x = e.clientX - tooltipWidth - 15;
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
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartDataForGranularity();
    renderChartByType();

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
        dropdown.append(`<option value="${source}">${displayName}</option>`);
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
    $('#token-usage-today-total').text(formatTokens(stats.today.total));
    $('#token-usage-today-in').text(formatTokens(stats.today.input || 0));
    $('#token-usage-today-out').text(formatTokens(stats.today.output || 0));
    $('#token-usage-today-reasoning').text(formatTokens(stats.today.reasoning || 0));
    $('#token-usage-mini-counter').text(formatTokens(stats.today.total));

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
    const todayKey = getDayKey(now);

    let weekCost = 0;
    let monthCost = 0;
    let todayCost = 0;

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
                    const cost = calculateCost(mInput, mOutput, mid);
                    weekCost += cost;
                    if (dayKey === todayKey) {
                        todayCost += cost;
                    }
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
    $('#token-usage-today-cost').text(`$${todayCost.toFixed(2)}`);

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

    // Update source dropdown options (in case new sources were added)
    updateSourceDropdown();

    // Update model colors grid
    renderModelColorsGrid();

    // Update current chat usage
    updateChatUsageDisplay();

    // Update health indicator
    updateHealthIndicator();

    // Update miniview if visible
    updateMiniviewStats();
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
        $('#token-usage-chat-id').text('No chat active');
        return;
    }

    const chatUsage = getChatUsage(chatId);

    $('#token-usage-chat-total').text(formatTokens(chatUsage.total));
    $('#token-usage-chat-messages').text(chatUsage.messageCount);
    $('#token-usage-chat-input').text(formatTokens(chatUsage.input));
    $('#token-usage-chat-output').text(formatTokens(chatUsage.output));
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
                    <span class="miniview-stat-label">Messages</span>
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
    $(miniviewElement).fadeIn(150);
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
 */
function applyMiniviewPosition() {
    if (!miniviewElement) return;

    const settings = getSettings();
    const position = settings.miniview?.position || { bottom: 80, right: 20 };

    // Validate position is within viewport bounds
    const rect = miniviewElement.getBoundingClientRect();
    const maxBottom = window.innerHeight - rect.height - 10;
    const maxRight = window.innerWidth - rect.width - 10;

    const validBottom = Math.max(10, Math.min(position.bottom, maxBottom));
    const validRight = Math.max(10, Math.min(position.right, maxRight));

    miniviewElement.style.bottom = `${validBottom}px`;
    miniviewElement.style.right = `${validRight}px`;
    // Clear any top/left that might interfere
    miniviewElement.style.top = 'auto';
    miniviewElement.style.left = 'auto';
}

/**
 * Setup drag and drop for miniview
 */
function setupMiniviewDrag() {
    if (!miniviewElement) return;

    const header = miniviewElement.querySelector('.miniview-header');
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startBottom = 0;
    let startRight = 0;

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

        // Get current position from computed style
        const style = window.getComputedStyle(miniviewElement);
        startBottom = parseInt(style.bottom, 10) || 80;
        startRight = parseInt(style.right, 10) || 20;

        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Calculate movement deltas (inverted because we're using bottom/right)
        const deltaX = startX - clientX;
        const deltaY = clientY - startY;

        // Calculate new position
        let newRight = startRight + deltaX;
        let newBottom = startBottom - deltaY;

        // Constrain to viewport
        const rect = miniviewElement.getBoundingClientRect();
        const maxRight = window.innerWidth - rect.width - 10;
        const maxBottom = window.innerHeight - rect.height - 10;

        newRight = Math.max(10, Math.min(newRight, maxRight));
        newBottom = Math.max(10, Math.min(newBottom, maxBottom));

        // Apply new position
        miniviewElement.style.right = `${newRight}px`;
        miniviewElement.style.bottom = `${newBottom}px`;
    };

    const onMouseUp = () => {
        if (!isDragging) return;

        isDragging = false;
        header.style.cursor = 'grab';

        // Save position to settings
        const style = window.getComputedStyle(miniviewElement);
        const settings = getSettings();
        if (!settings.miniview) {
            settings.miniview = { pinned: false, mode: 'session', position: {} };
        }
        if (!settings.miniview.position) {
            settings.miniview.position = {};
        }
        settings.miniview.position.bottom = parseInt(style.bottom, 10) || 80;
        settings.miniview.position.right = parseInt(style.right, 10) || 20;
        saveSettings();
    };

    // Mouse events
    header.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Touch events for mobile
    header.addEventListener('touchstart', onMouseDown, { passive: false });
    document.addEventListener('touchmove', onMouseMove, { passive: false });
    document.addEventListener('touchend', onMouseUp);
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

    // Mouse events
    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Touch events for mobile
    handle.addEventListener('touchstart', onMouseDown, { passive: false });
    document.addEventListener('touchmove', onMouseMove, { passive: false });
    document.addEventListener('touchend', onMouseUp);
}

/**
 * Update miniview stats based on current mode
 */
function updateMiniviewStats() {
    if (!miniviewElement) return;

    const settings = getSettings();
    const mode = settings.miniview?.mode || 'session';
    const stats = getUsageStats();
    const now = getCurrentEasternTime();

    let data;
    let cost = 0;

    switch (mode) {
        case 'session':
            data = stats.session;
            // Calculate session cost (rough estimate using current model prices)
            // For simplicity, use the ratio of session to allTime
            if (stats.allTime.total > 0) {
                const allTimeCost = calculateAllTimeCost();
                cost = allTimeCost * (stats.session.total / stats.allTime.total);
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


/**
 * Render the model colors grid with price inputs
 */
function renderModelColorsGrid() {
    const grid = $('#token-usage-model-colors-grid');
    if (grid.length === 0) return;

    const stats = getUsageStats();
    const models = Object.keys(stats.byModel || {}).sort();

    if (models.length === 0) {
        grid.empty().append('<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.5; padding: 8px; text-align: center;">No models tracked yet</div>');
        return;
    }

    // If grid is already populated with the same models, don't wipe it (prevents input focus loss)
    const existingRows = grid.children('.model-config-row');
    if (existingRows.length === models.length) {
        // Assume same order check isn't needed for now, unlikely to change order rapidly
        return;
    }

    grid.empty();

    for (const model of models) {
        const color = getModelColor(model);
        const prices = getModelPrice(model);

        const row = $(`
            <div class="model-config-row" style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                <input type="color" value="${color}" data-model="${model}"
                       class="model-color-picker"
                       style="width: 20px; height: 20px; padding: 0; border: none; cursor: pointer; flex-shrink: 0; border-radius: 4px;">
                <span title="${model}" style="font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--SmartThemeBodyColor); flex: 1;">${model}</span>
                <span style="font-size: 8px; color: var(--SmartThemeBodyColor); opacity: 0.5; flex-shrink: 0;">Price</span>
                <input type="number" class="price-input-in" data-model="${model}" value="${prices.in || ''}" step="0.01" min="0" placeholder="In" title="Price per 1M input tokens" style="width: 28px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0;">
                <input type="number" class="price-input-out" data-model="${model}" value="${prices.out || ''}" step="0.01" min="0" placeholder="Out" title="Price per 1M output tokens" style="width: 28px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0;">
            </div>
        `);

        // Color picker handler
        row.find('.model-color-picker').on('change', function () {
            setModelColor(String($(this).data('model')), String($(this).val()));
            renderChartByType();
        });

        // Price input handlers with debounce
        let debounceTimer;
        const handlePriceChange = () => {
            const mId = model; // closure
            const pIn = row.find('.price-input-in').val();
            const pOut = row.find('.price-input-out').val();
            setModelPrice(mId, pIn, pOut);
            // Trigger UI update to recalc costs
            updateUIStats();
        };

        row.find('input[type="number"]').on('input', function () {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(handlePriceChange, 500);
        });

        grid.append(row);
    }
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
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <span id="token-usage-mini-counter" style="margin-left: 8px; font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.75;" title="Today's total tokens">${formatTokens(stats.today.total)}</span>
                    <span id="token-usage-health-indicator" style="margin-left: 6px; font-size: 10px; cursor: help;" title="Extension health status">🟢</span>
                    <button id="token-usage-miniview-toggle" class="menu_button" style="margin-left: 6px; padding: 2px 6px; font-size: 10px;" title="Toggle compact miniview">📊</button>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Chart Header: Today stats + Range/Source selectors -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <div style="display: flex; align-items: baseline; gap: 6px;">
                                <span style="font-size: 18px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-today-total">${formatTokens(stats.today.total)}</span>
                                <span id="token-usage-today-cost" style="font-size: 12px; color: var(--SmartThemeBodyColor); opacity: 0.8;">$0.00</span>
                                <span style="font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> today</span>
                            </div>
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;">
                                <span id="token-usage-today-in">${formatTokens(stats.today.input || 0)}</span> in /
                                <span id="token-usage-today-out">${formatTokens(stats.today.output || 0)}</span> out /
                                <span id="token-usage-today-reasoning">${formatTokens(stats.today.reasoning || 0)}</span> 🧠
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
                    <div style="display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 6px;">
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
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> /msg</span>
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
                                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> /msg</span>
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
                                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Messages</div>
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
                                </div>
                                <div style="margin-top: 6px; font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-chat-id">No chat active</div>
                            </div>
                        </div>
                    </div>

                    <!-- Config (Model Colors & Prices) -->
                    <div class="inline-drawer" style="margin-top: 10px;">
                        <div class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Config</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div id="token-usage-model-colors-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;"></div>
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

    // Range button handlers
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
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
                if (Math.abs(newWidth - lastWidth) > 5) {
                    lastWidth = newWidth;
                    renderChartByType();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }

    // Fallback: window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(renderChart, 100);
    });
}

/**
 * Patch SillyTavern's background generation functions to track tokens
 * - generateQuiet / generate_quiet (Used by Summarize, generated prompts, etc.)
 * - ConnectionManagerRequestService.sendRequest (Used by extensions like Roadway)
 */
let isTrackingBackground = false;

function patchBackgroundGenerations() {
    patchGenerateQuietPrompt();
    patchConnectionManager();
}

function patchGenerateQuietPrompt() {
    // For quiet generations (Guided Generations, Summarize, Expressions, etc.),
    // MESSAGE_RECEIVED doesn't fire. Flush pending tokens on next generation or chat change.
    // IMPORTANT: These handlers must be non-blocking to avoid freezing the UI
    eventSource.on(event_types.GENERATION_STARTED, (type, params, dryRun) => {
        if (dryRun) return;
        if (isQuietGeneration && pendingInputTokensPromise) {
            // Schedule flush but don't await - prevents blocking the generation
            flushQuietGeneration().catch(e => {
                console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
            });
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (isQuietGeneration && pendingInputTokensPromise) {
            // Schedule flush but don't await - prevents blocking UI
            flushQuietGeneration().catch(e => {
                console.error('[Token Usage Tracker] Error flushing quiet generation on chat change:', e);
            });
        }
    });
}

/**
 * Flush a pending quiet generation, recording tokens from what we have
 */
async function flushQuietGeneration() {
    if (!pendingInputTokensPromise) return;

    try {
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        const sourceId = pendingSourceId;

        // Try to get output from streaming processor
        let outputTokens = 0;
        if (streamingProcessor?.result) {
            outputTokens = await countTokens(streamingProcessor.result);
        }

        // Record the usage
        if (inputTokens > 0 || outputTokens > 0) {
            recordUsage(inputTokens, outputTokens, null, modelId, sourceId);
        }
    } catch (e) {
        console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
    } finally {
        // Reset state
        pendingInputTokensPromise = null;
        pendingModelId = null;
        pendingSourceId = null;
        isQuietGeneration = false;
    }
}

function patchConnectionManager() {
    // Poll for ConnectionManagerRequestService (used by Roadway and similar extensions)
    const checkInterval = setInterval(() => {
        try {
            const context = getContext();
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(checkInterval);
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

            ServiceClass.sendRequest = async function (profileId, messages, maxTokens, custom, overridePayload) {
                if (isTrackingBackground) {
                    return await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
                }

                let inputTokens = 0;
                const modelId = getCurrentModelId();
                const sourceId = getCurrentSourceId();

                try {
                    isTrackingBackground = true;

                    try {
                        inputTokens = await countInputTokens({ prompt: messages });
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest input:', e);
                    }

                    const result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);

                    try {
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
                } finally {
                    isTrackingBackground = false;
                }
            };

            ServiceClass.sendRequest._isPatched = true;
            clearInterval(checkInterval);
        } catch (e) {
            console.error('[Token Usage Tracker] Error in patchConnectionManager:', e);
        }
    }, 1000);

    // Stop polling after 30 seconds
    setTimeout(() => clearInterval(checkInterval), 30000);
}

/**
 * Generic handler for background generations with recursion guard
 */
async function handleBackgroundGeneration(originalFn, context, args, inputCounter, outputCounter) {
    // Avoid double counting if one patched function calls another
    if (isTrackingBackground) {
        return await originalFn.apply(context, args);
    }

    let result;
    let inputTokens = 0;
    const modelId = getCurrentModelId();
    const sourceId = getCurrentSourceId();

    try {
        isTrackingBackground = true;

        // Count input tokens
        try {
            inputTokens = await inputCounter();
            console.log(`[Token Usage Tracker] Counting background input. Tokens: ${inputTokens}`);
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background input:', e);
        }

        // Execute original
        result = await originalFn.apply(context, args);

        // Count output tokens
        try {
            const outputTokens = await outputCounter(result);
            if (outputTokens > 0 || inputTokens > 0) {
                recordUsage(inputTokens, outputTokens, null, modelId, sourceId);
                console.log(`[Token Usage Tracker] Background usage recorded: ${inputTokens} in, ${outputTokens} out`);
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background output:', e);
        }
    } finally {
        isTrackingBackground = false;
    }

    return result;
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    // Sync time with external source on startup
    syncTimeOffset().then(success => {
        if (success) {
            console.log('[Token Usage Tracker] External time sync successful');
        } else {
            console.log('[Token Usage Tracker] Using local time with Eastern timezone conversion');
        }
    });

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);

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
