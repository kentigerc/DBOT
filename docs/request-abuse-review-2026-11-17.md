# Deriv rate limiting and request-abuse review — 17 November 2026

## Evidence and changes

The quoted 301-second message comes from Deriv HTTP 429 or a retained cooldown, not a maintenance status check. The delay follows Retry-After; missing/invalid headers use 30 seconds. No production access logs, Render deployment logs or authenticated live Deriv requests were available, so the original triggering endpoint, quota scope and request volume remain unconfirmed.

Reviewed OAuth exchange/refresh, account discovery, HTTP session refresh callers, Analysis polling, OTP issuance, socket upgrades/reconnects, public feeds, API protection and static routing.

Existing protections retained: concurrent account reads share a task; successful ownership reads expire after 30 seconds; ownership and logout are rechecked after asynchronous authorization; only discovery GETs retry transient 502/503/504 responses; OTPs, orders and authorization-code exchanges are not replayed; provider response bodies are not exposed. Public market sockets do not issue authenticated OTPs. The header refreshes at 60 seconds and on focus/visibility/online events; Analysis polling shares the server account cache.

Verified gaps patched:

- Browser session cooldowns were memory-only. Store only their expiration time in localStorage, honor it across tabs/reloads, tolerate unavailable storage, and clear it on logout. Session data and credentials remain out of storage.
- Server cooldowns were endpoint-specific. Bearer REST calls now share cooldowns for the same provider origin and credential hash. This deliberately pauses discovery after an OTP 429 instead of continuing different requests on that credential. Other credentials have separate keys; token exchanges retain their request-specific scope.
- Add at most one safe provider-rate diagnostic per second per process: `deriv_rate_limited`, endpoint with the OTP account ID masked, and Retry-After seconds. No token, URL query, body or account identifier is logged.
- Static routes bypassed HTTP rate/concurrency protection. All routes, including health, now share a 40/sec, burst-400 IP bucket and the existing 128-request active budget. API/session/auth-specific restrictions still apply.
- Socket message budgets could be multiplied by connection count. Retain 50/sec burst-100 per connection and add 400/sec burst-1200 per IP and 200/sec burst-600 per authenticated session. Upgrade attempts share a 1/sec burst-16 session budget across IPs, alongside existing IP/global/socket-count limits.

The HTTP server additionally caps total TCP connections at 512 by default (NETO_MAX_HTTP_CONNECTIONS, validated 16–10000), limits each keep-alive connection to 1000 HTTP requests and uses a five-second keep-alive timeout. This bounds pending-header connections as well as routed requests.

Existing request protections include 8 KiB API JSON limits, 16 KiB HTTP headers, 15-second header/upgrade deadlines, 30-second request deadline, strict origins, verified session identities, bounded token-bucket maps, rate-limited hashed-IP rejection logs, 64 KiB WebSocket frames, no WebSocket compression, bounded queues/backpressure and session-expiry enforcement. IP quotas do not trust arbitrary leading forwarded addresses.

## Deployment requirements and limits

These limits and cooldowns are process-local. Deployments restart them; multiple replicas multiply them unless a shared limiter is added. The current single-instance deployment remains the supported configuration.

On Render, verify RENDER=true and the actual forwarded-address chain before changing NETO_TRUST_PROXY_HOPS (default 1 on Render, otherwise 0). Incorrect proxy trust can group all users under the proxy or let clients evade limits. NETO_MAX_SOCKETS defaults to 256; size it to instance capacity and leave headroom below NETO_MAX_HTTP_CONNECTIONS for ordinary HTTP traffic. Check the new diagnostic against Render request/deploy logs when the 301-second error recurs. Request Deriv's applicable REST quota and scope (credential, app ID or egress IP); a shared Render egress IP or other app traffic cannot be diagnosed from the message alone.

Application limits cannot prevent a network-volume DDoS before it reaches Render. Use provider/edge DDoS protection and WAF/rate rules, preserve WebSocket upgrades, avoid challenges on API/socket routes, and avoid caching private APIs. If adding a proxy such as Cloudflare, verify the entire trusted-hop chain and prevent direct-origin bypass using supported origin controls. Do not blindly increase proxy trust or lower quotas until normal multi-tool traffic is measured. No Render, DNS or WAF settings were changed from this workspace.

## Regression coverage

Tests cover persistent/cross-tab browser cooldowns, the OTP-to-discovery 301-second cooldown with exact expiry and redacted diagnostics, static floods and health, global concurrency release, aggregate public/private socket message budgets, session upgrade churn across IPs, and existing authentication/security behavior. Full CI includes PostgreSQL-backed server tests, frontend tests, dependency audit and production build.

## Follow-up — 18 November 2026

A reported 427-second cooldown occurred on refreshing the platform. This proves a provider limit or retained countdown reached the session gate; without the production `deriv_rate_limited` log it does not identify the original endpoint, quota scope or triggering workload. Public live inspection was unavailable from this workspace. The new hedging bot starts only on Run and does not dispatch trades on page load.

Previously, page/session display refreshed the same account-discovery cache used for ownership checks every 30 seconds, and a discovery 429 blocked entry to the workspace even when this server recently verified those accounts. Separate display freshness (five minutes) from trading/owner authorization freshness (30 seconds). A credential-scoped display snapshot may be shown for up to fifteen minutes during a 429, with an explicit warning and provider retry duration. It never authorizes an account, trading connection or owner-only API. Changed account ownership is still fetched by trading operations after 30 seconds and updates the display cache. Recheck session revocation after all account reads, including fallback; terms acceptance remains required. No snapshot from another credential, expired snapshot or arbitrary browser account data is accepted.

Cooldowns remain enforced and are not shortened. A server restart, a new login without a verified snapshot or a snapshot older than fifteen minutes may still require waiting for Deriv's limit to expire. No provider quota, Render configuration or security restriction was bypassed. Added in-process regression tests exercise discovery volume, trading rejection after account removal, bounded fallback, exact cooldowns, credential separation, logout and revocation; frontend coverage checks the warning and retained platform navigation.

## User isolation — 18 November 2026

Provider cooldowns remain keyed by the provider origin and credential hash, never one application-wide timer. Added a two-user regression proving a 427-second OTP cooldown for one credential does not block a second credential in the same server process.

Local HTTP, socket-upgrade and message admission now checks signed-session allowances before consuming shared IP capacity. Previously rejected session requests could still drain shared IP buckets. Signed-in and public traffic have separate IP buckets so an anonymous flood cannot exhaust the authenticated network allowance. Each signed session, or each public IP for unauthenticated requests, may hold at most sixteen concurrent HTTP requests. The global 128-request and configured socket capacity guards remain. Socket session quotas are checked before spending the network upgrade budget; message session quotas are checked before the network message budget. Existing origin, ownership, proxy trust, message validation, size limits and revocation checks remain enforced.

Before requesting a fresh single-use Deriv connection token, enforce both login-session and verified-account budgets: eight initial attempts, refilling one attempt every ten seconds. Rejected ownership checks cannot spend another account's budget. This reduces reconnect churn reaching the shared provider infrastructure; tokens are never cached or replayed. Local rejections affect that login/account rather than setting a provider-wide cooldown.

Isolation is bounded by shared infrastructure: aggregate network limits and global service capacity still protect availability, and Deriv may impose app-wide or Render outbound-IP limits independently of NetoAcademy's per-user controls. Absolute immunity for all users cannot be promised. Review redacted `deriv_rate_limited` logs with Deriv to establish quota scope and request any app-level capacity increase; do not rotate IPs/App IDs or remove abuse guards to evade provider limits. Keep one supported server instance unless limit coordination is moved to a shared store. Render proxy trust and an upstream WAF/DDoS service still need deployment verification. No Render or Deriv settings were changed here.
