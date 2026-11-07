# Server trading state persistence

Analysis Tool, HIT AND RUN, Even / Odd and Momentum now use PostgreSQL for their server journals whenever `DATABASE_URL` is configured. The existing database connection variable is sufficient; there is no new credential to enter. State lives in the separate `neto_trading_state` table, created automatically on first use with parameterized queries. Startup logs print the selected journal mode, without credentials. `Server trading journal: postgres.` identifies the selected backend, not a successful health probe.

The journal includes settings, financial counters, recovery/batch state, the bounded trade history and pending purchase intent/contract ID. It does not contain Deriv access/refresh tokens. Account keys are hashed; the saved account identity is validated before restoration. Database access, TLS, backups, capacity and retention remain deployment responsibilities.

## Purchase and restart behavior

1. Save the pending intent and wait for the PostgreSQL commit before sending a buy. A failed or uncertain save prevents that purchase. STOP, account state and live entry conditions are checked again after the save, so a delayed commit cannot blindly execute an outdated entry.
2. Record acknowledgements and settlements in order. Repeated heartbeat updates coalesce while a write is in progress, keeping only one in-flight and one latest snapshot per account. A purchase checkpoint waits for its own committed revision rather than for an indefinitely growing queue.
3. After a process restart, load the saved state with automated entry stopped. An unexpired prior-process lease is respected until it expires (normally at most 15 seconds). No connection or purchase is created merely by opening the tool.
4. A known pending contract can be checked against Deriv and settled once. An uncertain purchase without a contract ID requires explicit reconciliation from Deriv history; it is never bought again automatically. If a settlement save failed, the older durable pending record still supports reconciliation of that result.
5. Database failures or conflicting revisions stop new entries. The process does not silently switch to local files or keep writing stale state. Following a failed database write, repair the database connection and restart the service to reload its authoritative state before manually continuing. Do not delete pending records or force a reset to bypass reconciliation.
6. Shutdown rejects new starts/Builder purchases, requests STOP, and drains saved state within the server's shutdown window. A hard kill still leaves the last committed intent for recovery. The provider may have accepted a buy whose acknowledgement never arrived; atomicity across Deriv and PostgreSQL is not claimed.

## First deployment and legacy files

Stop running server tools and let open contracts settle before the first deployment of this migration. Existing valid `.analysis-state` files are imported only when a database row is absent **and those files are still available to the new process**. Existing database history takes precedence. A corrupt or mismatched journal fails closed.

Render can discard an old instance's ephemeral files during deployment. This migration cannot transfer files that are unavailable or already removed, or reconstruct missing prior per-tool statistics. PostgreSQL protects state committed after activation. Without `DATABASE_URL`, local atomic file journals remain available for development/preview, but an ephemeral filesystem does not provide persistence across replaced Render instances.

## Scope and remaining work

This change covers the four server-run analysis strategies. Bot Builder and XML Auto execution still run in the browser; their execution journal has not been moved to PostgreSQL in this step. Before a new Builder purchase, the bridge loads/checks the server journal so an unresolved server-tool purchase cannot be bypassed after a restart.

Revision checks reject stale snapshot writers; separate shared account locks now cover Builder/XML and server tools. Keep one Node process and one Render trading-service instance. Shared per-account locks and owner-only health checks/alerts have now been added; see [account protection and monitoring](account-locks-and-monitoring.md). Live deployment failover/load testing and full cross-instance UI/operational readiness remain outstanding.

## Verification

The isolated PostgreSQL tests cover process reconstruction, legacy migration, stale writers, malformed account binding, a committed intent before provider purchase, lost acknowledgements, and failed settlement saves followed by reconciliation without a duplicate buy or duplicate profit. Engine tests also cover delayed/failed commits, STOP during a checkpoint and a changed live signal. Tests use synthetic accounts and local fake provider responses, with no live orders.

Final validation: 458 application tests, 117 server tests with isolated local PostgreSQL 16, production build, and production-entrypoint startup/shutdown smoke checks passed. The dependency audit reports zero known advisories. Repository-wide TypeScript checking still has its pre-existing diagnostics; no diagnostics were reported in the changed files. No live Render database or trading account was used for these checks.
