/**
 * Bounded reuse of tokenizer results, and the prompt walk that decides what gets counted.
 * A count depends only on tokenizer, model and text, so a hit records what asking the host
 * again would return; the host's own cache still has to hash every field of every prompt.
 */

// Cached texts stay in memory, so both entries and characters are capped
const MAX_CACHED_ENTRIES = 2048;
const MAX_CACHED_CHARS = 2_000_000;
// A text this large (a whole text-completion prompt) rarely repeats and would evict the rest
const MAX_CACHED_TEXT_CHARS = 200_000;
const MAX_PARALLEL_COUNTS = 4;

/**
 * List the texts to tokenize in a prompt, separately from its fixed framing costs
 * @param {string|object[]} prompt - Text-completion string or chat-completion messages
 * @returns {{texts: string[], fixedTokens: number}}
 */
export function collectPromptTexts(prompt) {
    const texts = [];
    let fixedTokens = 0;
    const add = (text) => {
        if (text && typeof text === 'string') texts.push(text);
    };
    const addFunctionCall = (call) => {
        add(call.name);
        add(call.arguments);
    };

    // For text completion APIs (kobold, novel, textgen) - prompt is a string
    if (typeof prompt === 'string') {
        add(prompt);
    }
    // For chat completion APIs (OpenAI) - prompt is an array of messages
    else if (Array.isArray(prompt)) {
        for (const message of prompt) {
            // Content can be a string or an array of content parts (for multimodal)
            if (typeof message.content === 'string') {
                add(message.content);
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'text') add(part.text);
                    // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                    // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                    if (part.type === 'image_url' || part.type === 'image') fixedTokens += 765;
                }
            }
            // Count role tokens (~1 token per role)
            if (message.role) fixedTokens += 1;
            // Count name field tokens (used in function calls, tool results, etc.)
            add(message.name);
            // Count tool_calls tokens (Standard OpenAI)
            if (Array.isArray(message.tool_calls)) {
                for (const toolCall of message.tool_calls) {
                    if (toolCall.function) addFunctionCall(toolCall.function);
                }
            }
            // Count invocations tokens (SillyTavern internal)
            if (Array.isArray(message.invocations)) {
                for (const invocation of message.invocations) {
                    if (invocation.function) addFunctionCall(invocation.function);
                }
            }
            // Count deprecated function_call tokens
            if (message.function_call) addFunctionCall(message.function_call);
        }
        // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
        fixedTokens += prompt.length * 3;
    }

    return { texts, fixedTokens };
}

/**
 * @param {object} deps
 * @param {(text: string) => Promise<number>} deps.tokenize - The host tokenizer
 * @param {(text: string) => number} deps.estimate - Fallback when the tokenizer fails; never cached
 * @param {() => string} deps.getSignature - Identifies the tokenizer and model a count would use
 * @param {(error: unknown) => void} deps.onError
 * @param {object} [limits]
 */
export function createTokenCounter({ tokenize, estimate, getSignature, onError }, {
    maxEntries = MAX_CACHED_ENTRIES,
    maxChars = MAX_CACHED_CHARS,
    maxTextChars = MAX_CACHED_TEXT_CHARS,
    maxParallel = MAX_PARALLEL_COUNTS,
} = {}) {
    /** @type {Map<string, number>} Oldest first */
    const cache = new Map();
    let cachedChars = 0;
    let cacheSignature = null;

    /** Read the current signature, dropping counts made with any other tokenizer or model. */
    function syncSignature() {
        let signature = null;
        try {
            signature = getSignature();
        } catch {
            // Tokenizer not available yet: count without caching
        }
        if (signature !== cacheSignature) {
            cache.clear();
            cachedChars = 0;
            cacheSignature = signature;
        }
        return signature;
    }

    function readCached(text) {
        const tokens = cache.get(text);
        if (tokens !== undefined) {
            cache.delete(text);
            cache.set(text, tokens);
        }
        return tokens;
    }

    function store(text, tokens, signature) {
        if (signature === null || !Number.isFinite(tokens) || text.length > maxTextChars) return;
        // The model may have changed while this count was in flight
        if (syncSignature() !== signature || cache.has(text)) return;
        cache.set(text, tokens);
        cachedChars += text.length;
        for (const oldest of cache.keys()) {
            if (cache.size <= maxEntries && cachedChars <= maxChars) break;
            cache.delete(oldest);
            cachedChars -= oldest.length;
        }
    }

    // In-flight counts are deliberately not shared between calls: the host's tokenizer promise
    // can stay pending forever after a network failure and must not block later requests.
    async function countUncached(text, signature) {
        let tokens;
        try {
            tokens = await tokenize(text);
        } catch (error) {
            onError(error);
            return estimate(text);
        }
        store(text, tokens, signature);
        return tokens;
    }

    return {
        /**
         * @param {string} text
         * @returns {Promise<number>}
         */
        async count(text) {
            if (!text || typeof text !== 'string') return 0;
            const signature = syncSignature();
            return readCached(text) ?? countUncached(text, signature);
        },

        /**
         * Sum the counts of many texts, tokenizing each distinct uncached one with bounded parallelism
         * @param {string[]} texts
         * @returns {Promise<number>}
         */
        async countAll(texts) {
            const signature = syncSignature();
            /** @type {Map<string, number>} Uncached text and how many times it occurs */
            const uncached = new Map();
            let total = 0;
            for (const text of texts) {
                const tokens = readCached(text);
                if (tokens !== undefined) total += tokens;
                else uncached.set(text, (uncached.get(text) || 0) + 1);
            }

            const pending = uncached.entries();
            const worker = async () => {
                for (const [text, occurrences] of pending) {
                    const tokens = await countUncached(text, signature);
                    total += tokens * occurrences;
                }
            };
            await Promise.all(Array.from({ length: Math.min(maxParallel, uncached.size) }, worker));
            return total;
        },

        get size() {
            return cache.size;
        },
        get chars() {
            return cachedChars;
        },
    };
}
