# NetoAcademy owner dashboard

Open `/admin` on your NetoAcademy site. Admin API responses require a valid Deriv trading login whose provider-verified active account list includes an allowlisted owner account. The frontend's Admin link is only a convenience; authorization is enforced independently on every admin API request. There is no public admin signup or password embedded in the app.

## Enable owner access on Render

In the **netoacademy web service → Environment**, add:

| Variable                 | Value                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `NETO_ADMIN_ACCOUNT_IDS` | Your exact Deriv account ID from NetoAcademy's account menu. Multiple owners may be comma-separated. |

Save the environment change and let Render restart the service. Log in with the Deriv user that owns that account, then open `/admin` (or use the Admin header link). No new domain or workspace upgrade is required to test. The owner ID is server configuration and is deliberately absent from the public repository. Local development can put this variable in the ignored `.env` file.

## Commission reporting

In the dashboard, select **Connect developer reporting**, authorize the application's read-only `application_read` scope, then select **Refresh commission**.

Reporting authorization is stored in a separate encrypted HttpOnly cookie. It does not replace the trading session or grant new trading access. Reporting expires according to Deriv's token lifetime; reconnect reporting when requested. Normal users' login continues to request only `trade`. If the developer application is not allowed the reporting scope, enable that permission in Deriv's app registration or contact Deriv; the site cannot grant it itself.

The reporting request uses Deriv's official `/applications/v1/markup-statistics` endpoint and the configured App ID. Only that app's breakdown row is displayed. Missing permissions, absent rows and failures show unavailable/not reported, never invented earnings or estimated deductions. These are provider-reported period totals, not a withdrawal balance. Deriv may report with a delay. The API supplies per-app aggregates; per-user or per-bot commission is not inferred from these totals. Affiliate-programme earnings are separate and are not included here. Select daily detail (up to 31 days) or monthly detail to request actual reporting buckets. These are fetched only on an explicit refresh, with at most two concurrent reporting calls and a 60-second credential-specific cache; no daily amounts are estimated from a period total.

## Durable history

For durable analytics, connect a PostgreSQL database and set its private connection string as **`DATABASE_URL`** in Render's environment. Never paste the database password into chat or commit it. Use your provider's TLS connection settings; the application does not disable certificate verification. PostgreSQL tables/indexes are created automatically by the application and deduplicate events by their server-generated keys.

Without `DATABASE_URL`, file preview mode works for testing. The dashboard labels it clearly: a process restart keeps the file, but Render's ephemeral filesystem can erase it on redeployment or replacement. Preview capacity is limited to 100,000 events. Do not treat it as permanent history. `NETO_ANALYTICS_DIR` changes the local directory (default `.analytics-state`, ignored by git). Adding a database starts an independent store; existing preview history is not automatically migrated.

Keep `NETO_SESSION_SECRET` stable: it protects sessions and pseudonymizes analytics identifiers. Rotating it requires planning a history migration because identity keys change. PostgreSQL records have 366-day retention, pruned daily. Visitor cookies last 90 days. Preview files are capacity-limited, not a permanent retention system.

## What the numbers mean

- **Online browsers:** visible tabs with a first-party heartbeat within 90 seconds; not an exact count of humans. Multiple devices/cookie resets and automated visits affect estimates.
- **Signed-in browsers:** those heartbeats have a locally valid encrypted login session.
- **Live Deriv connections:** authenticated account WebSocket bridges currently open on this server; accounts are also counted distinctly so two devices do not become two accounts.
- **Active server bots:** running Analysis Tool/HIT AND RUN sessions. Browser Bot Builder execution is not represented as a server bot.
- **Connected accounts:** distinct provider-verified account IDs in the period, not the number of people. One person can have multiple demo/real accounts.
- **Confirmed purchases/results:** obtained from the Deriv socket bridge and server strategy state, not browser-reported P/L. Repeated purchase/settlement messages are deduplicated. Results are grouped by purchase date. Demo and real results and currencies stay separate. Money results currently target the site's USD options trading sessions; unknown account metadata is labelled unknown.
- **Tool usage:** distinct browser/tool combinations per day, summed over the selected period; not individual clicks or exact time spent. The separate trading-by-tool table uses confirmed contracts.

Dates and CSV daily buckets use UTC to match Deriv reports. Visitor history begins when tracking is enabled; previous visitors cannot be reconstructed. Confirmed analytics are operational reports, not a replacement for Deriv's statements. During storage outages, a bounded retry queue retains events while the process is alive, and the dashboard reports pending/dropped tracking. A process loss during an outage can leave gaps. Live counters and refresh coordination currently target a single server instance; share presence/coordinators before scaling across replicas.

No names, emails, raw account IDs, IP addresses, URL queries or credentials are written to the analytics event store. Identity hashes, coarse page identifiers, verified account type/currency, timestamps and aggregate contract amounts are stored. Admin pages and OAuth callbacks do not send visitor heartbeats.

## Validation

The server suite includes owner denial/verification, separate reporting credentials, same-origin heartbeats, duplicate events, date validation, configured-app commission filtering, missing commission authorization, persistent preview data and provider socket capture. The optional PostgreSQL integration test uses `NETO_TEST_DATABASE_URL`, requires a localhost database named `neto_analytics`, and verifies idempotence, reconnect persistence and retention. Never point it at a production database.

A local PostgreSQL 16 container and simulated browser owner dashboard were used for validation; no real trades or live developer-report tokens were used. Real Deriv reporting still requires the owner's grant and app permissions.

### Activity by user

The owner dashboard includes **Trading by user**, grouped by the existing HMAC account reference, account type and currency for the selected UTC dates. It shows confirmed purchases, settled/open contracts, wins, losses, volume and trader net P/L, sorted by volume. References identify accounts, not people: one person can have separate real/demo or currency accounts. References persist across devices and restarts provided `NETO_SESSION_SECRET` stays unchanged. Raw account IDs are not stored or exposed by this table. Existing tracked trade records are included without a schema migration. Non-trading accounts do not appear in this table.

This is activity attribution, not individual commission. Deriv's reporting endpoint provides app-level commission only. No per-user commission is estimated or allocated from those totals. The table uses the same server-enforced owner authorization as all dashboard data.

### Cross-tool settlement attribution

Bot Builder keeps an account-wide `proposal_open_contract` subscription open, including while server tools trade. Analytics must attribute a contract to its confirmed purchase, not whichever socket first observes settlement. Builder reporting now accepts settlements only for contract IDs with a Builder purchase receipt observed in this process (bounded 20,000-receipt registry shared across browser sockets). The admin collector also retains purchase attribution through settlement. Reconnected sockets can settle known Builder purchases; after a process restart, an unrecognized Builder settlement is not imported as a new Builder purchase.

Historical reports select tool, stake and purchase-date metadata from the stored purchase event, independently of settlement row order. This corrects old cross-tool settlement labels at read time without editing PostgreSQL or changing account-wide P/L. Historical contracts lacking a recorded purchase cannot have their original tool reconstructed reliably by this correction. Period totals still include all recorded sessions/users, not just the current session shown in a tool.
