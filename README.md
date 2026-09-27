# Token Usage Tracker (Modified)

![Extension Screenshot](1.png)

A SillyTavern extension that tracks and visualizes token usage and price for your chats. This is a modified version with additional features.

## Installation

1.  Open SillyTavern and navigate to the **Extensions** menu (blocks icon).
2.  Click on **Install Extension**.
3.  Paste the repository URL into the "Extension URL" field:
    ```
    https://github.com/bla6987/ST_Token_Modified
    ```
4.  Click **Install for all users** or **Install just for me**.

## Features

### Compact Miniview
- Floating panel with glassmorphism styling
- Toggle via `/tokenmini` slash command or header button
- Session, hourly, and daily data views
- Pin functionality to keep the panel visible
- **Drag-and-drop** positioning by dragging the header
- **Resizable** from bottom-left corner handle
- Position and size persistence in settings
- Supports mouse and touch events

### Token Tracking
- Real-time token usage tracking
- **Reasoning/thinking token tracking** with 🧠 indicator
- Per-chat usage statistics via `/tokenchat` command
- Cost calculation based on model pricing
- Shared model pricing with expandable provider variants, individual overrides, and automatic inheritance for future matching variants

### Charts & Visualization
- Daily and hourly usage charts
- **Tokens | Generations** metric toggle
- Multiple time range options: **1D (Today)**, 7D, 30D, 90D
- Improved hourly chart readability

### Generation Metrics
- Generation counts per hour/day, available for your whole history
- Stopped and failed generation attempts, with success rate, tracked from version 1.2.0 onward
- `/tokentoday` shows today's and this hour's generations, stopped, failed and success rate

### API Error Tracking
- Errors from chat and text completion requests, grouped by route: source, endpoint host, model and provider
- Error counts and failure rate per route, broken down by HTTP status or error type, plus a log of recent errors
- Catches errors SillyTavern only shows as a toast: error payloads sent with HTTP 200 and error events in the middle of a stream
- `/tokenerrors` lists routes with errors; `/tokenerrors clear` clears them

### Time Synchronization
- External time sync with worldtimeapi.org for Eastern timezone
- 5-minute auto-resync interval for time drift correction
- Timezone-aware date operations using Intl.DateTimeFormat

### Code Improvements
- Centralized `getCurrentChatId()` helper function
- Mini token counter in extension header

## Usage

Once installed, the extension will automatically start tracking token usage. The GUI will be in the extensions menu.

- Use `/tokenmini` to toggle the compact miniview
- Use `/tokenchat` to view current chat statistics
- Use `/tokenerrors` to list API errors by source, endpoint, model and provider

### Shared model pricing

For a quick bulk update, search in **Config**, type the input/output prices in the fields immediately below the search, then click **Apply to N matching models**. This updates every matching model ID across all pages, replacing any existing individual prices. Matching is case-insensitive; an empty search applies to all known models. Only matching model IDs change, even when other aliases appear in the same expanded group. This is a one-time update; shared group rates and links remain unchanged.

Open **Token Usage Tracker → Config**, search for a model, enter input/output prices in **$/1M tokens**, and click **Save shared**. Every linked variant uses this price unless it has an individual override. Future matching variants inherit it too.

- Expand a model to see each variant, its effective price, and whether it uses shared pricing, an override, or automatic pricing.
- **Save override** sets a different price for one variant. **Use shared** removes that override.
- **Link to** moves an unusually named alias into another pricing group. Existing overrides follow the variant; use **Use shared** to adopt the destination group's rate.
- **Separate** takes a variant out of the suggested group while preserving its configured effective price.
- **Use automatic pricing** removes a group's shared rate and falls back to the existing OpenRouter pricing cache for variants without overrides.

Suggested groups match exact versioned model names after simple provider/organization prefixes (for example, `anthropic/claude-3.7-sonnet` and `proxy/anthropic/claude-3.7-sonnet`). Dates, versions, quantization markers, `:free`, and `thinking` suffixes remain distinct. Unrecognized names stay separate until manually linked.

Existing prices are preserved on upgrade. The first time a shared price is saved, identical existing prices become inherited prices; different prices remain overrides. Later shared-price edits preserve all overrides. Search filters whole groups and never limits the scope of a shared-price edit. Costs, including historical estimates, use the currently configured rates as before. Usage records and model identities are unchanged.

`/tokenexport` and `/tokenimport` include shared prices and manual links. New-format backups restore the complete pricing configuration; older backups continue to merge exact-model prices.

### Generation metrics

Switch the chart to **Generations** to plot how many generations ran per hour or day. A generation is one recorded response: normal, swipe, continue, impersonate, quiet/background (Summarize, Guided Generations, etc.), and stopped generations with partial output.

- **Past data:** generation counts exist for all history, but only as a total. Per-model and per-source counts start with version 1.2.0, so older bars are drawn as one neutral block and show 0 when a source filter is selected.
- **Stopped:** you stopped the generation. Its input and any partial output still count toward tokens.
- **Failed:** the attempt ended without a result (for example a rate-limit, server or network error, or an error response). Failed attempts add no tokens.
- **Attempts** = generations + failed. **Success rate** = (generations − stopped) ÷ attempts.
- Periods that began before stopped/failed tracking started show **—** instead of a success rate.

Failures are inferred from SillyTavern's generation lifecycle and each request's result, including error payloads and error events in a stream. Calls made with `generateRaw` are not counted as generations (their errors still appear under **API Errors**).

### API errors

Open **Token Usage Tracker → API Errors** to see which API, provider and model combinations return errors. Each route is one combination of:

- **Source:** the chat completion source (for example Custom (OpenAI-compatible) or OpenRouter), or the text completion API type.
- **Endpoint:** the host of the custom URL, reverse proxy or text completion server. Only the host is stored, never the path, query or credentials.
- **Model:** the model ID sent with the request.
- **Provider:** the upstream provider named in the response (OpenRouter reports which provider served or failed a request), otherwise the requested provider order.

Each route shows failed / total requests, the error rate, a breakdown by HTTP status or error type, and the latest error message. **Recent errors** lists the last 20 errors; the last 100 are kept. Every generation request is tracked, including Connection Manager profile requests, background generations and connection tests.

Error types, when there is no HTTP status:

- **stream:** the stream contained an error event, an event that was not JSON, or SillyTavern could not read it.
- **interrupted:** the connection dropped during a stream.
- **network:** the request never reached SillyTavern's server.
- An error code from the payload, when one is given.

SillyTavern answers a failed non-streaming OpenAI-compatible request with HTTP 200 and only the upstream's status text; when that text is a standard reason phrase (such as "Too Many Requests") it is counted under its status (429). Stopping a generation is never counted as an error. Errors are kept separately from usage, so **Reset All** does not clear them; use **Clear errors** or `/tokenerrors clear`. `/tokenexport` and `/tokenimport` include them.

Other extensions can read the data from `window.TokenUsageTracker.getErrorRoutes()` and `getErrorLog()`.

Run the regression tests with `node --test tests/` (Node 22.7+).

## Credits

Based on [Extension-TokenUsage](https://github.com/Vibecoder9000/Extension-TokenUsage) by Vibecoder9000.

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See the `LICENSE` file for details.
