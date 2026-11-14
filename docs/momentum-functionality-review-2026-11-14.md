# Momentum 70 functionality review — 14 November 2026

Starting revision: `ee6b5b1781678313ef9df0940e5ed69b5a471294`. Its GitHub CI run passed the production build and full test suites before this pass. The defaults are 2.1× martingale and two ticks for new/reset sessions; saved settings are retained.

## Verified issues and fixes

1. **Status polls could undo completed command responses in the UI.** A poll beginning during RUN or STOP shared the command's sequence number. If its older response arrived after the command response, it replaced the correct active/stopped state. Successful commands now advance the response fence before accepting their reply. Regressions cover both directions of the race.
2. **Momentum could lose its identity during first startup.** The server starts portfolio/account preparation asynchronously, while the saved engine can still belong to the default tool. The client saw a busy account belonging to another tool and disabled Momentum STOP. Authenticated snapshots now include the validated requested settings during preparation. The client uses this metadata for display, without changing the engine's saved settings, journal or purchase controls. Tests cover startup from another device and STOP before any engine start.
3. **Early startup failures could disappear.** A failed portfolio check could leave the saved tool identity unchanged, hiding Momentum's error panel; inactive status reads from the persisted journal also omitted the command error. Snapshots retain the requested tool/error context after failed startup, including the persisted-status path. Manual STOP during startup is treated as cancellation rather than a startup error. Lock-loss/provider failures remain errors.
4. **The preview could show an unrelated market while a normal trade was open.** The rotating preview ignored the pending trade's symbol. It now pins to an open or unconfirmed purchase's market and labels that state, while preserving the watchlist and existing recovery lock.

## Scope and checks

Reviewed default/custom controls, normal entry and recovery selection, ten-second momentum ranking, one-time digit patterns, purchased recovery locks, stake progression, three-win batches, STOP/resume, pending reconciliation, cross-device startup/status and preview rendering. The trading strategy, duration options, risk limits, balance checks and shared account protection are unchanged by these fixes.

Four focused client runtime checks failed against the previous implementation and pass after the fix (RUN/STOP response ordering and startup/error identity). Two direct-handler checks likewise reproduced missing startup/error metadata and pass after the fixes. These checks use the actual client/handler source with controlled responses and Node's TypeScript transform; they do not replace the normal Jest/server suites. All 28 pure Momentum rule cases still pass in the local runtime check. The local sandbox still lacks installed dependencies and refuses listening sockets, so full validation is performed through GitHub CI. The new Jest, HTTP server and UI regressions are committed with the fixes.

No live orders, production database changes or Render deployment were performed. Automated tests do not establish live Deriv execution or deployment health. Confirm the deployed revision and run an owner-controlled demo session before relying on live trading.
