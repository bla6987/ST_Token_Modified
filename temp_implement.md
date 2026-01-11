# OpenRouter Auto-Pricing Feature

Automatically fetch and cache OpenRouter model pricing, auto-populating prices for models the user hasn't manually configured.

## Proposed Changes

### [index.js](file:///home/pop/Downloads/Extensions/Extension-TokenUsage/index.js)

#### 1. Add OpenRouter Pricing Cache to Settings
Add a new `openRouterPrices` object to `defaultSettings` to store cached pricing data from OpenRouter's API. Include a `lastFetched` timestamp for cache invalidation.

```diff
const defaultSettings = {
    showInTopBar: true,
    modelColors: {},
    modelPrices: {},
+   openRouterPrices: {
+       data: {},         // { "model-id": { prompt: 0.000001, completion: 0.000002 } }
+       lastFetched: null // Timestamp of last API fetch
+   },
    // ...
};
```

#### 2. Add `fetchOpenRouterPricing()` Function
New async function that:
- Fetches from `https://openrouter.ai/api/v1/models` (public, no auth required)
- Parses the response and extracts pricing per model
- Stores in `settings.openRouterPrices.data`
- Sets `lastFetched` timestamp
- Only runs if cache is older than 24 hours

#### 3. Add `maybeAutoFetchOpenRouterPricing()` Function  
Conditional fetch that:
- Checks if current source is 'openrouter' via [getCurrentSourceId()](file:///home/pop/Downloads/Extensions/Extension-TokenUsage/index.js#290-302)
- If not OpenRouter, returns immediately (no API call)
- If OpenRouter and cache is stale (>24h), fetches fresh data

#### 4. Modify [getModelPrice()](file:///home/pop/Downloads/Extensions/Extension-TokenUsage/index.js#1205-1214) Function
Update logic to:
1. First check `settings.modelPrices[modelId]` (user-defined, takes priority)
2. If no user-defined price, check `settings.openRouterPrices.data[modelId]`
3. Convert OpenRouter's per-token pricing to our per-1M-tokens format
4. Return `{ in: 0, out: 0 }` if neither exists

```diff
function getModelPrice(modelId) {
    const settings = getSettings();
+   // User-defined prices take priority
    if (settings.modelPrices[modelId]) {
        return settings.modelPrices[modelId];
    }
+   // Auto-populated from OpenRouter cache
+   const orPrice = settings.openRouterPrices?.data?.[modelId];
+   if (orPrice) {
+       // OpenRouter returns price per token, convert to per 1M tokens
+       return {
+           in: (orPrice.prompt || 0) * 1000000,
+           out: (orPrice.completion || 0) * 1000000
+       };
+   }
    return { in: 0, out: 0 };
}
```

#### 5. Hook Auto-Fetch into Initialization
Call `maybeAutoFetchOpenRouterPricing()` during extension init and when API source changes.

---

## Verification Plan

### Manual Testing
Since this extension runs inside SillyTavern, manual testing requires:

1. **Configure SillyTavern to use OpenRouter** as the API
2. **Open browser dev tools** (F12) → Console
3. **Reload SillyTavern** - should see console logs indicating OpenRouter pricing fetch
4. **Open Token Usage settings** - verify model prices show up for OpenRouter models
5. **Verify no fetch when using other APIs** - switch to Claude/OpenAI, confirm no OpenRouter API call is made
6. **Verify user prices take priority** - manually set a price for a model, confirm it uses that instead of auto-fetched price

Would you like me to proceed with this implementation?