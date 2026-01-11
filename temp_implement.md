1. Session data persists across page reloads (Most likely unexpected)
At index.js:192-194, the "session" usage data is stored in extension_settings and only resets if startTime is null. This means your "session" tokens survive browser refreshes and even browser restarts. Most users would expect "session" to reset when they close/reload the page.

2. Race condition with "continue" generations
At index.js:775-805, when you use "continue" to extend a message, the pre-continue token count is calculated asynchronously without waiting:


(async () => {
    // ... calculates preContinueTokenCount
})();
If the async function hasn't finished when handleMessageReceived runs, preContinueTokenCount will be 0, causing the entire continued message to be counted as new tokens instead of just the delta.

3. Week number calculation is non-standard
At index.js:232-240, the week key calculation doesn't follow ISO 8601. It can produce incorrect week numbers, especially around year boundaries (e.g., Dec 31 might show as week 53 or week 1 depending on the day).

4. Import data merges instead of replacing - can double your stats
At index.js:1419-1431, importing data adds to existing days rather than replacing. If you export your data and import it again, all your token counts will be doubled.

5. Missing reasoning field in session reset
At index.js:526-533, the reset object is:


settings.usage.session = {
    input: 0,
    output: 0,
    total: 0,  // missing reasoning: 0
    messageCount: 0,
    startTime: ...
};
But reasoning tokens are tracked elsewhere. After reset, the old reasoning value could persist.

6. External time sync is non-blocking on startup
At index.js:3485-3491, time sync is fire-and-forget. Early token recordings before sync completes will use local time, while later ones use external time - this can cause timestamps to be inconsistent within the same session.