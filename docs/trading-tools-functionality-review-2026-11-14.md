# Trading tools functionality review — 14 November 2026

Starting point: `e7d582a306d28ee92595641ae1ffcdbe1cb3ac79`, including the previous Momentum startup/status fixes. Scope includes the server Analysis Tool, HIT AND RUN, Even/Odd and Momentum; Bot Builder/hosted XML, XML Auto and Manual Trader's Switcher workflow; shared account, purchase, recovery and demo-pause controls. Charts and the risk calculator do not submit orders.

## Additional verified issues fixed

- **Analysis Tool STOP during startup:** its button required `wantsRun`, which is still false while the server prepares a first run. It now permits STOP whenever the client reports an active/preparing session. Integration coverage exercises startup STOP across all four server tools.
- **Stopped settings crossed account boundaries:** the shared draft hook retained another account's edited stake/limits when the newly selected account had no session for that tool; logout also retained those edits. Account changes now restore that account's saved settings when applicable, or the tool's defaults. Ordinary polling still preserves edits on the same account. Four tool-specific regressions cover account changes and logout.
- **Rejected browser buys could create phantom pending state:** the combined purchase guard reserved scanner/XML state before checking Manual Trader. A late Manual Trader rejection could therefore leave an unsent order marked in-flight. Manual Trader now provides a read-only preflight, checked before any reservation. The existing reserving method still prevents concurrent purchases. Tests verify rejected orders leave no reservation and a later eligible purchase can proceed.
- **A journal-rendering exception could invalidate a confirmed XML Auto demo win:** the final success notification was inside the trading error handler without logging isolation. It is now isolated so a UI journal failure does not stop the confirmed recovery. Incomplete/failed demo outcomes, STOP and account controls still block resumption.

## Review boundaries

Inspected startup cancellation, saved settings, selected-account changes, contract/duration support, normal/recovery entry gates, shared per-account purchase protection, stake/balance/session limits, pending/unknown purchases, settlement deduplication, real-to-demo recovery pauses, STOP/resume and XML batch transitions. Manual Trader retains its loaded Switcher's XML recovery rules. No strategy thresholds, multipliers, default durations or recovery mappings were changed in this pass.

Focused local runtime reproductions failed against the original draft hook and combined purchase guard, and pass after their fixes. The repository also contains Jest/UI regressions for the four findings. Local checks do not use live credentials or submit trades. Full frontend/server tests, dependency audit and production build are run through GitHub CI because the local execution sandbox lacks installed dependencies and blocks listening sockets.

This review does not certify that all functionality bugs are absent. Render deployment, real provider execution, device/network failure behavior at the deployed edge and the owner's live demo-account checks remain separate. No production settings, database rows or live orders were changed here.
