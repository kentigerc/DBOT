# Account protection and private health checks

Implemented 7 November 2026 (Africa/Nairobi). The existing `DATABASE_URL` enables shared protection; no additional secret is required. Local development without PostgreSQL keeps process-local protection, explicitly reported as a warning in the owner dashboard.

## What the locks do

Each Deriv account has one shared owner lease and at most one pending/open NetoAcademy purchase at a time. Bots that attempt simultaneous purchases on the same account will have the additional purchase rejected; different accounts remain independent. Analysis Tool, HIT AND RUN, Even / Odd, Momentum and XML/Builder purchases use the same guard. Different accounts remain independent. An active server runner renews its 30-second lease every five seconds and checks protection before purchases. Ownership changes invalidate older tokens, so a delayed old runner cannot use a replacement's lease.

Before forwarding a buy, a pending marker is committed to PostgreSQL. Expiration alone cannot transfer an account that still has a pending purchase. Provider acknowledgements associate contract IDs, and verified account-scoped settlement packets clear them. Settlement receipts also cover messages arriving through another socket/server before the acknowledgement is saved. Receipts are pruned in bounded batches after one day; an old contract can be checked in Reports again if its receipt is needed.

A definitive provider rejection or a locally cancelled, unsent request can clear its marker. Network errors and uncertain outcomes do not. When PostgreSQL/protection checks fail, new purchases stop. A lease lost during a server run stops new entries; an existing contract can still settle normally. STOP cancels a local runner even if the database notification fails. A STOP arriving at another instance is delivered through the holder's five-second renewal check, with the shared flag blocking further protected purchases.

Server snapshots are refreshed under ownership before a new start/reset. Inactive instances can read current persisted status, and old engine instances are fenced from writing over a replacement. Pending server-tool records retain their existing verified contract reconciliation path.

## Recovery limits

A known Builder/XML contract can be checked in Deriv Reports; a verified settled response clears the matching shared marker. **If the acknowledgement was lost and the contract ID was never recorded, automatic takeover remains blocked.** The dashboard flags expired sessions with pending purchases. A verified recovery procedure is required before clearing an unknown outcome; this change intentionally provides no timed or blind force-unlock mechanism. Never delete lock/journal rows merely to restart trading.

PostgreSQL and Deriv do not share one transaction. These guards prevent another NetoAcademy session from silently taking over an unresolved purchase; they do not claim provider-side exactly-once execution across every failure, prevent trades placed directly through other Deriv apps, or reconstruct missing legacy browser history. Stop and settle existing bots before the first deployment of this guard so pre-deployment purchases are not mistaken for protected new ones.

Keep **one Render trading-service instance** until live deployment/failover/load testing, shared abuse limits and complete cross-instance UI telemetry are verified. Lock coordination is shared, while market telemetry, browser XML execution, analytics live counters and some monitoring remain per instance. This change does not turn on autoscaling or purchase a hosting upgrade.

## Owner-only monitoring

The existing verified admin authorization protects `/api/admin/health`; ordinary users and unauthenticated requests cannot run its private probes or read its results. The Admin page adds **Platform health**, refreshed every 30 seconds, showing:

- Actual trading-journal, account-protection and analytics database probes.
- Runtime/origin configuration checks.
- Shared protected-account and pending-purchase counts.
- Warnings for expired sessions with unresolved purchases, account-lock loss, journal failures and observed trading-connection interruptions.
- A bounded list of operational alerts and recovery transitions, without credentials, database URLs, raw driver errors or account identifiers.

Background checks also run every 30 seconds. Alerts are displayed in the owner dashboard and emitted as sanitized JSON events in Render logs. No email, SMS, Slack or other external notification delivery was configured. Alert history is in memory and resets on restart; persistent pending/lock records remain in PostgreSQL. External uptime alerts are still needed to notify an owner when the entire server is down.

The panel describes what each probe actually observed. It does not certify DNS, TLS termination, WAF/DDoS protection, backups/restoration, MFA or provider configuration.

## Validation

Tests use an isolated PostgreSQL database and synthetic provider responses. They cover competing owners, independent accounts, expired idle takeover, protected pending outcomes, stale-token rejection, cross-connection settlement ordering, remote STOP, lost renewals, two independent service instances, authorization of health checks and credential-free diagnostics. No live orders were placed.

Final verification: 65 application suites / 461 tests and 134 server tests passed, including isolated PostgreSQL concurrency checks. Production build, actual PostgreSQL operational probes and production-entrypoint startup/shutdown checks passed. Chromium checks confirmed the owner panel at desktop and mobile widths with no recorded CSP/runtime errors; a non-owner neither saw the panel nor requested its probes. The dependency audit reports zero known advisories. Repository-wide TypeScript checking still has pre-existing diagnostics; no diagnostics were reported in changed files. No live trades or live Render account configuration were used.
