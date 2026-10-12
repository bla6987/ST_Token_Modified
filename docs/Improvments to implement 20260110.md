# Improvements checklist

Reviewed against the local source on 2026-10-12. All features from the original January plan are implemented. Checked items describe code present in the extension; they do not imply a new live-device test.

## Chart — complete

- [x] Toggle between line and bar charts (`renderChartByType`, chart-type controls).
- [x] Daily and hourly usage views (`getChartDataForGranularity`).
- [x] Token efficiency metrics (`calculateEfficiencyMetrics`, session/all-time displays).

## Data — complete

- [x] Import and export JSON backups (`importUsageData`, `exportUsageData`); CSV export is also available through `/tokencsv`.
- [x] Compact pinnable miniview with session, hourly and daily modes.
- [x] Per-chat usage view (`getChatUsage`, `updateChatUsageDisplay`, `/tokenchat`).

## Slash commands — complete

- [x] Common actions: `/tokenusage`, `/tokenreset`, `/tokencost`, `/tokentoday`, `/tokenchat`, `/tokenmini`, `/tokenexport`, `/tokenimport`, `/tokencsv`, `/tokenerrors`.

## Reliability — complete

- [x] Health indicator (`getHealthStatus`, `updateHealthIndicator`).
- [x] Review and resolve the six concerns in [temp_implement.md](../temp_implement.md), including the startup time-sync concern addressed on 2026-10-12.

## Remaining work

No unimplemented feature remains from this plan. A live SillyTavern check of the new startup clock behavior remains to be done; automated clock and generation-tracking regressions cover the change.
