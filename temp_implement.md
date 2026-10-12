# Reliability review

Reviewed against local source on 2026-10-12. This file originally listed six suspected issues with references to an older `index.js`; those line numbers are obsolete.

| Original concern | Current status | Implementation evidence |
|---|---|---|
| Session persisted across page reloads | **Implemented** | `loadSettings()` resets session usage and `startTime` on page load. |
| Continue token-count race | **Implemented** | `handleGenerationStarted()` captures `preContinuePromise`; `countMessageOutput()` awaits it before subtracting prior tokens. |
| Non-standard week numbering | **Implemented** | `getWeekKey()` uses ISO week numbering and the Thursday's year at year boundaries. |
| Import could double statistics | **Implemented** | `importUsageData()` overwrites matching bucket entries rather than adding their counts. Other existing buckets remain; this is an idempotent merge, not deletion of all existing history. |
| Session reset omitted reasoning | **Implemented** | `resetSession()` and startup reset explicitly set `reasoning: 0`. |
| Startup external time sync was fire-and-forget | **Implemented on 2026-10-12** | Initialization awaits the bounded clock sync before creating session/tracking timestamps. `time.js` shares one request, throttles successes and failures for five minutes, retains the last good offset, and falls back to local time after a three-second request timeout. |

## Time-sync findings and resolution

The old timestamp getter started a new sync on every read until a successful request finished. Failures never updated its retry timestamp, so offline or rate-limited clients could repeatedly request time. Overlapping responses could overwrite each other's offsets. It also preferred whole-second `unixtime` and subtracted arrival time, introducing avoidable rounding and request-latency error.

- [x] Share an in-flight sync across initialization and timestamp reads.
- [x] Complete or time out the initial sync before initializing usage timestamps.
- [x] Limit refresh attempts to one per five minutes after either success or failure, measured with a monotonic clock.
- [x] Retain the last successful correction when a later refresh fails; use local time if none has succeeded.
- [x] Prefer precise `datetime` and estimate correction against the request midpoint; retain `unixtime` fallback.
- [x] Cover startup near Eastern midnight, concurrent reads, failed retries, refresh failure, malformed/HTTP responses, fallback parsing, synchronous fetch errors and timeout in `tests/time.test.mjs`.

## Remaining validation

- [ ] Exercise startup and a later refresh in a live SillyTavern browser, including an unavailable time service.

The correction is an estimate from an HTTP time sample, not a precision time protocol. Later successful refreshes can still correct the clock; previously stored history is not re-bucketed. No migration of existing usage data is part of this fix.
