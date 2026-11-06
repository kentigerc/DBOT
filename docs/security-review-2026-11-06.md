# NetoAcademy prelaunch security review — 6 November 2026

**Status: application hardening completed for this pass; unrestricted public launch is NOT cleared.** This is a source review plus local regression/browser testing, not a penetration-test certificate. It does not establish that every vulnerability in the two supplied lists is absent, or that the live Render/DNS/cloud configuration is secure. No attack traffic or trading orders were sent to Deriv, Render or other third parties; dependency metadata was queried from npm/GitHub and the application was tested locally with synthetic trading responses.

## Concrete changes

- Replaced native JavaScript evaluation in tick-delay validation with a bounded numeric parser. Imported bot XML rejects DTDs/entities, oversized input and excessive blocks. Remote XML imports require final HTTPS URLs, omit credentials, reject redirects and limit download size/time.
- Sanitized HTML error messages with an allowlist and updated DOMPurify. Added a CSP that forbids inline scripts/native eval, externalized both startup scripts, added a safe static-keyword adapter for the legacy bot interpreter, replaced the default route stack-trace display with a generic error page, prevented framing, and applied security headers to API/error/static responses. Static delivery blocks repository/config/backup/source/debug paths, verifies realpath containment and streams files instead of buffering whole assets.
- Added bounded HTTP/auth limits, connection quotas including pending handshakes, WebSocket size/message limits and handshake deadlines. Fixed proxy-hop trust, ambiguous query parameters, malformed frame handling and account-rebinding requests. Unknown strategy fields are rejected rather than being mass-assigned.
- Added persistent logout revocation checks across handlers/replicas. Production uses PostgreSQL; file fallback is for one process with durable storage. New trading buys check revocation before forwarding; idle account sockets recheck on their 30-second heartbeat. **HTTPS cookie names now use `__Host-`; existing users must log in again after deployment.**
- Added bounded security event logging without raw IPs, tokens or full URLs. Tightened service-worker caching. Updated maintained Node 24 defaults, pinning of active CI actions, dependency checks and fork-specific CI permissions/scope. Added weekly Dependabot configuration.

## Release requirements still open

1. Resolve or independently assess the remaining dependency advisories, especially `@deriv/deriv-charts` / `lodash.set` and glob-related `minimatch` / `brace-expansion`. No audit suppression was added. A clean npm audit would still not prove application security.
2. In the existing Render web service, set **NODE_VERSION to `24`**, rebuild, and confirm the running version. Editing render.yaml does not prove an existing service's environment changed. Set NETO_ORIGIN to the exact deployed HTTPS origin; register the matching `/callback` in Deriv. Keep NETO_SESSION_SECRET as a stable, server-only cryptographically random secret of at least 32 bytes. Verify NETO_ADMIN_ACCOUNT_IDS contains only the intended owner (`ROT91643925` from this conversation).
3. Use DATABASE_URL for production revocations and analytics, restrict database network access, verify the provider's recommended TLS/certificate settings, and test backup restoration. Without PostgreSQL, an ephemeral Render filesystem cannot preserve logout revocations across replacement instances. Keep trading intent journals on durable storage and test restart/reconciliation.
4. Keep **one Node process and one Render trading-service instance** until distributed per-account trading locks are implemented and tested. Persistent logout checks are shared in PostgreSQL, but trading-runner locks and abuse buckets remain per process. Do not enable horizontal replicas/autoscaling yet.
5. Verify Render/CDN/WAF protections for volumetric DDoS, request smuggling, TLS versions/renewal, WebSocket upgrades, cache rules and upstream access. Application rate limiting cannot absorb a distributed network flood. NETO_TRUST_PROXY_HOPS defaults to one only when Render's `RENDER=true` marker is present; verify the real proxy chain. Never trust arbitrary client X-Forwarded-For values. NETO_MAX_SOCKETS defaults to 256; quotas are guards, not a claim that the server can support 256 active traders.
6. Enable MFA on Deriv, GitHub, Render and the registrar. Review branch/environment protections, GitHub secret scanning/push protection, dependency updates and least-privilege access. Review DNS for dangling records and configure SPF/DKIM/DMARC if the domain sends email. No live DNS or provider settings were verified here.
7. Configure alerts for repeated blocked events, upstream/storage failures, unexpected logins/trading, resource usage and dependency disclosures. Validate retention, deletion, encryption, privacy notices and any data-residency/legal requirements. The credential-pattern scan is supplementary and cannot certify that all current/history secrets are absent; rotate any real exposed credential rather than only removing it from git.
8. Obtain an independent security assessment in a staging environment before broad public use, including authenticated multi-user tests, imported malicious XML, WebSocket authorization/rate bypass, concurrency and deployment-edge testing. Unknown vulnerabilities, compromised browser extensions and third-party code cannot be ruled out by this pass.

## Verification evidence

See the final verification record below. Automated checks use local fixtures, fake provider responses and synthetic accounts. PostgreSQL integration checks ran against an isolated local PostgreSQL 16 instance; all server tests passed without skips. CI now provisions the same dedicated test database. No production database or provider password/MFA configuration was inspected.

## Coverage legend

Each checklist row references the following scoped finding/control group. “Tested” means the particular checks described here passed; it does **not** mean exhaustive clearance of the named vulnerability class.

### Q — SQL: source review and tests

PostgreSQL statements use bound parameters and fixed table/column names in analytics and revocations. Account IDs are verified before queries; reports have date/row limits. Parameterized queries and durable revocation sharing were exercised against an isolated local PostgreSQL 16 database. No penetration test or inspection of the production database was performed.

### X — Code/HTML: hardened and tested; vendor risk remains

Removed native Function evaluation from tick-delay validation; numeric-only parsing, input bounds and malicious-expression tests. HTML error messages use an explicit DOMPurify allowlist. JSX renders text normally. CSP blocks inline scripts and native eval. This does not prove every possible XSS/sandbox escape absent; remaining chart dependency findings remain open.

### F — Files/XML: hardened and tested

Bot imports are browser-side XML, limited to 2 MB and 10,000 blocks; DTD/entity declarations are refused. HTTPS-only remote imports omit credentials, refuse redirects and have size/time limits. No server upload/archive extraction endpoint exists. Static delivery blocks dotfiles, repositories, source maps, source directories, backup/archive/log extensions and the debug page; realpath containment blocks symlink escape. Assets stream with backpressure.

### A — OAuth/session: hardened and regression tested

Provider trade-only OAuth uses S256 PKCE, random state and fresh random session IDs. Access/refresh tokens are opaque to this app and stored in AES-256-GCM authenticated HttpOnly cookies with purpose-bound AAD. HTTPS cookies use \_\_Host-, Secure, Path=/ and SameSite=Lax. Exact Origin checks protect state-changing HTTP routes; WebSocket origins are checked. Logout revocations persist (PostgreSQL in production) and are checked on authorization, refresh and new purchases. Existing private sockets are rechecked on requests and on their 30-second heartbeat. Absolute renewal lifetime remains bounded. Users must sign in again after this cookie-name migration.

### O — Ownership/privileges: source review and regression tests

Private account/report/bot routes verify server-side authentication. Accounts come from Deriv, not browser claims. Admin access is an allowlist of provider-verified accounts, independent of navigation visibility. Account IDs and contract ownership remain provider-scoped. Socket reauthorization is blocked; duplicate account parameters and unknown strategy settings are rejected. Extra authorization scenarios still warrant independent testing.

### T — Trading integrity: tested for current single-instance deployment

Existing tests cover one server runner per account, STOP during startup, cross-device Builder locks, portfolio checks, balance rechecks, quote/stake validation, deduplicated settlements and unknown-purchase reconciliation. No buy is blindly retried by the security changes. Existing recovery and normal-entry policies are unchanged by this hardening. Distributed account locks are NOT implemented: do not run multiple Node workers/Render replicas for trading yet. Deriv owns execution/balances and the platform has no cart/refund/payment processor.

### R — Abuse limits: hardened; edge protection unverified

Bounded HTTP token buckets, auth buckets, pending request limits, connection quotas (including pending upgrades), frame limits, message rates, backpressure and handshake/request/header deadlines. Proxy trust is a fixed operator-configured hop count; forged leading X-Forwarded-For values are not trusted. Quotas are per process and are not a substitute for a WAF, provider DDoS protection, shared limits or capacity testing.

### H — Browser/HTTP/cache: hardened and tested within stated scope

CSP, frame-ancestors/X-Frame-Options, nosniff, no-referrer, Permissions-Policy, same-origin resource policy and HTTPS HSTS apply centrally. Private APIs are no-store. CSP permits HTTPS/WSS connections and approved Google scripts to preserve supported imports/integrations; it is not a complete exfiltration allowlist. Service-worker caching excludes cross-origin/query/auth/API/admin requests and private/no-store responses, and rotates its cache. TLS termination, proxy/cache behavior and HTTP desynchronization must also be verified at the Render/CDN edge.

### D — Data/secrets/observability: reviewed; operational checks required

No bearer token is returned by the session metadata endpoint. OTP targets are strictly pinned to Deriv. Committed-source credential-pattern scan reports locations only and found no matches in its supported formats; it is not an exhaustive secret/history audit. Server-side secrets are not added to the frontend build allowlist. Security logs are bounded JSON events with HMAC-pseudonymized client IDs and omit request bodies, cookies, credentials and full URLs. File storage uses restricted permissions; backup encryption, retention, alert delivery and access logs require operator verification.

### S — Supply chain: patched, remaining findings OPEN

Updated DOMPurify, Lodash, Handlebars, Router, cookie/XML packages and vendor release-tool dependencies. Node target is maintained 24.x; CI uses verified commit-pinned official actions and npm ci. Legacy Deriv deployments/translation jobs are disabled for this fork. Weekly Dependabot configuration and a supplemental credential-pattern CI check were added. The audit still reports findings: see the dependency appendix. No claim of a clean supply chain or zero-day protection.

### P — External/platform: NOT VERIFIED

Actual Render settings, canonical-domain DNS, certificate negotiation/renewal, WAF/CDN rules, Postgres network restrictions/backups, cloud bucket ACLs, GitHub account/branch protections and SPF/DKIM/DMARC were not available to inspect through this workspace. Repository defaults are not evidence that these live controls are enabled. Verify before launch.

### E — Provider-owned: NOT VERIFIED at provider

NetoAcademy uses Deriv OAuth and does not collect passwords, implement password resets, issue user MFA/OTP challenges or maintain its own identity/registration database. These controls belong to Deriv (and to the owner's Render/GitHub/domain-provider accounts). NetoAcademy protects the OAuth/session boundaries it owns; provider password/MFA/brute-force controls cannot be certified here.

### N — Not exposed by current app architecture

No corresponding LDAP, GraphQL, gRPC, NoSQL, SAML, SMTP, JWT-verification, webhook, serverless/Kubernetes, redemption/cart/refund or request-driven server template/command interface was found in the reviewed runtime routes. This is an architectural scope statement, not a guarantee about a hosting platform or a future feature.

### U — Residual/independent review or governance required

Unknown vulnerabilities, native/browser sandbox and extension compromise, arbitrary third-party compromise, data-residency/legal compliance and exhaustive side-channel/abuse testing cannot be cleared by these code changes. Independent assessment and continuous patching/monitoring remain required.

## Checklist A — first supplied list

| ID   | Concern                                  | Scoped coverage |
| ---- | ---------------------------------------- | --------------- |
| A001 | SQL Injection (SQLi)                     | Q               |
| A002 | Cross-Site Scripting (XSS)               | X               |
| A003 | Cross-Site Request Forgery (CSRF)        | A               |
| A004 | Broken Authentication                    | A               |
| A005 | Broken Access Control                    | O               |
| A006 | Insecure Direct Object References (IDOR) | O               |
| A007 | Sensitive Data Exposure                  | D               |
| A008 | Security Misconfiguration                | H               |
| A009 | Remote Code Execution (RCE)              | X               |
| A010 | File Upload Vulnerabilities              | F               |
| A011 | Directory Traversal (Path Traversal)     | F               |
| A012 | Denial of Service (DoS)                  | R               |
| A013 | Distributed Denial of Service (DDoS)     | R               |
| A014 | Server-Side Request Forgery (SSRF)       | F               |
| A015 | XML External Entity (XXE)                | F               |
| A016 | Command Injection                        | N               |
| A017 | LDAP Injection                           | N               |
| A018 | OS Command Injection                     | N               |
| A019 | Code Injection                           | X               |
| A020 | Insecure Deserialization                 | U               |
| A021 | Session Fixation                         | A               |
| A022 | Session Hijacking                        | A               |
| A023 | Clickjacking                             | H               |
| A024 | Open Redirect                            | H               |
| A025 | Host Header Injection                    | H               |
| A026 | HTTP Request Smuggling                   | H               |
| A027 | HTTP Response Splitting                  | H               |
| A028 | Directory Listing                        | F               |
| A029 | Weak Password Policies                   | E               |
| A030 | Credential Stuffing                      | E               |
| A031 | Brute Force Attacks                      | E               |
| A032 | Privilege Escalation                     | O               |
| A033 | Race Conditions                          | T               |
| A034 | CORS Misconfiguration                    | H               |
| A035 | DNS Misconfiguration                     | P               |
| A036 | Exposure of API Keys                     | D               |
| A037 | Vulnerable and Outdated Components       | S               |
| A038 | Unrestricted File Upload                 | F               |
| A039 | Business Logic Flaws                     | T               |
| A040 | Insufficient Logging and Monitoring      | D               |
| A041 | Security Header Misconfiguration         | H               |
| A042 | Cache Poisoning                          | H               |
| A043 | Subdomain Takeover                       | P               |
| A044 | Broken Cryptography                      | A               |
| A045 | Authentication Bypass                    | O               |
| A046 | API Security Misconfigurations           | O               |
| A047 | GraphQL Vulnerabilities                  | N               |
| A048 | Web Cache Deception                      | H               |
| A049 | Prototype Pollution                      | S               |
| A050 | Information Disclosure                   | D               |
| A051 | Memory Corruption Vulnerabilities        | U               |
| A052 | Zero-Day Vulnerabilities                 | U               |
| A053 | Third-Party Dependency Vulnerabilities   | S               |
| A054 | MitM Vulnerabilities                     | H               |
| A055 | Insecure Transport Layer                 | H               |
| A056 | Email Header Injection                   | N               |
| A057 | Parameter Tampering                      | O               |
| A058 | Hidden Field Manipulation                | O               |
| A059 | Cookie Poisoning                         | A               |
| A060 | Timing Attacks                           | A               |
| A061 | OAuth Misconfiguration                   | A               |
| A062 | JWT Vulnerabilities                      | N               |
| A063 | Account Enumeration                      | E               |
| A064 | TOCTOU Vulnerabilities                   | T               |
| A065 | SSTI                                     | N               |
| A066 | NoSQL Injection                          | N               |
| A067 | CRLF Injection                           | H               |
| A068 | WebSocket Security Vulnerabilities       | H               |
| A069 | Cloud Storage Misconfigurations          | P               |
| A070 | Container Escape Vulnerabilities         | P               |
| A071 | Kubernetes Misconfigurations             | N               |
| A072 | Supply Chain Attacks                     | S               |
| A073 | Cross-Site WebSocket Hijacking           | H               |
| A074 | Local File Inclusion                     | F               |
| A075 | Remote File Inclusion                    | F               |
| A076 | BOLA                                     | O               |
| A077 | BFLA                                     | O               |
| A078 | Mass Assignment                          | O               |
| A079 | SSRF via Cloud Metadata                  | F               |
| A080 | DNS Rebinding                            | F               |
| A081 | HTML Injection                           | X               |
| A082 | CSS Injection                            | X               |
| A083 | Blind SQL Injection                      | Q               |
| A084 | Second-Order SQL Injection               | Q               |
| A085 | DOM-Based XSS                            | X               |
| A086 | Stored XSS                               | X               |
| A087 | Reflected XSS                            | X               |
| A088 | XML Injection                            | F               |
| A089 | XPath Injection                          | N               |
| A090 | SMTP Injection                           | N               |
| A091 | Buffer Overflow                          | U               |
| A092 | Integer Overflow                         | T               |
| A093 | Use-After-Free                           | U               |
| A094 | Authentication Token Leakage             | A               |
| A095 | Session Token Leakage                    | A               |
| A096 | Exposure of Backup Files                 | F               |
| A097 | Exposure of Source Code                  | F               |
| A098 | Rate Limiting Failures                   | R               |
| A099 | Account Recovery                         | E               |
| A100 | Password Reset                           | E               |
| A101 | MFA Bypass                               | E               |
| A102 | CAPTCHA Bypass                           | E               |
| A103 | Resource Exhaustion                      | R               |
| A104 | API Rate Limit Bypass                    | R               |
| A105 | Hidden Endpoint Exposure                 | D               |
| A106 | Debug Interface Exposure                 | D               |
| A107 | Admin Panel Exposure                     | O               |
| A108 | Insecure Default Configurations          | D               |
| A109 | Improper Input Validation                | O               |
| A110 | Improper Output Encoding                 | X               |
| A111 | Improper Error Handling                  | D               |
| A112 | Improper Certificate Validation          | P               |
| A113 | Log Injection                            | D               |
| A114 | HTTP Header Injection                    | H               |
| A115 | Webhook Security                         | N               |
| A116 | Secret Management Failures               | D               |
| A117 | Data Integrity                           | T               |
| A118 | Metadata Exposure                        | D               |
| A119 | Browser Security Misconfigurations       | H               |
| A120 | CSP Misconfiguration                     | H               |
| A121 | Missing Security Headers                 | H               |
| A122 | Referrer Policy Misconfiguration         | H               |
| A123 | SameSite Cookie Misconfiguration         | A               |
| A124 | HSTS Misconfiguration                    | H               |
| A125 | Mixed Content                            | H               |
| A126 | Prototype Chain Pollution                | S               |
| A127 | Dependency Confusion                     | S               |
| A128 | Typosquatting                            | S               |
| A129 | Package Poisoning                        | S               |
| A130 | Client-Side Template Injection           | X               |
| A131 | DOM Clobbering                           | X               |
| A132 | XS-Leaks                                 | H               |
| A133 | Email Enumeration                        | E               |
| A134 | User Enumeration                         | E               |
| A135 | Broken Access Token Validation           | A               |
| A136 | Broken Session Management                | A               |
| A137 | Insecure Direct API References           | O               |
| A138 | Excessive Data Exposure                  | D               |
| A139 | Object Ownership Checks                  | O               |
| A140 | BOPLA                                    | O               |

## Checklist B — second supplied list

| ID   | Concern                            | Scoped coverage |
| ---- | ---------------------------------- | --------------- |
| B001 | API Key Leakage                    | D               |
| B002 | Secret Exposure                    | D               |
| B003 | Hardcoded Credentials              | D               |
| B004 | Source Map Disclosure              | F               |
| B005 | Git Repository Exposure            | F               |
| B006 | SVN Repository Exposure            | F               |
| B007 | Backup File Exposure               | F               |
| B008 | Environment File Exposure          | F               |
| B009 | Log File Exposure                  | F               |
| B010 | Configuration File Leakage         | F               |
| B011 | Cloud Bucket Misconfiguration      | P               |
| B012 | CDN Misconfiguration               | P               |
| B013 | Domain/Subdomain Hijacking         | P               |
| B014 | Dangling DNS Records               | P               |
| B015 | Email Spoofing (SPF/DKIM/DMARC)    | P               |
| B016 | Session Replay                     | A               |
| B017 | Session Puzzling                   | A               |
| B018 | Replay Attacks                     | A               |
| B019 | Token Prediction                   | A               |
| B020 | Weak Random Number Generation      | A               |
| B021 | Weak Encryption                    | A               |
| B022 | Certificate Misconfiguration       | P               |
| B023 | Certificate Spoofing               | P               |
| B024 | TLS Downgrade                      | P               |
| B025 | Padding Oracle                     | A               |
| B026 | BREACH/CRIME Compression Attacks   | H               |
| B027 | Browser Cache Disclosure           | H               |
| B028 | Cache Key Poisoning                | H               |
| B029 | Cache Deception                    | H               |
| B030 | Search Engine Disclosure           | H               |
| B031 | Metadata Leakage                   | H               |
| B032 | Error-Based Disclosure             | H               |
| B033 | Fingerprinting                     | H               |
| B034 | Version Disclosure                 | H               |
| B035 | Framework Disclosure               | H               |
| B036 | Username Enumeration               | E               |
| B037 | Email Enumeration                  | E               |
| B038 | Tenant Enumeration                 | O               |
| B039 | Resource Enumeration               | O               |
| B040 | Business Process Abuse             | T               |
| B041 | Coupon Abuse                       | N               |
| B042 | Payment Manipulation               | T               |
| B043 | Price Tampering                    | T               |
| B044 | Cart Manipulation                  | N               |
| B045 | Refund Abuse                       | N               |
| B046 | Account Takeover                   | A               |
| B047 | Forced Browsing                    | O               |
| B048 | Hidden Parameters                  | O               |
| B049 | HTTP Parameter Pollution           | O               |
| B050 | Mass Registration Abuse            | E               |
| B051 | Invitation Abuse                   | E               |
| B052 | MFA Fatigue                        | E               |
| B053 | OTP Bypass                         | E               |
| B054 | OTP Brute Force                    | E               |
| B055 | Magic Link Abuse                   | E               |
| B056 | Password Spraying                  | E               |
| B057 | Session Confusion                  | A               |
| B058 | Authorization Confusion            | A               |
| B059 | OAuth Account Linking              | A               |
| B060 | SAML Vulnerabilities               | N               |
| B061 | OIDC Misconfigurations             | E               |
| B062 | Federated Authentication           | A               |
| B063 | CSP Bypass                         | X               |
| B064 | Sandbox Escape                     | U               |
| B065 | Browser Extension Abuse            | U               |
| B066 | Service Worker Abuse               | H               |
| B067 | WebRTC Leakage                     | N               |
| B068 | DNS Zone Transfer                  | P               |
| B069 | Reverse Proxy Misconfiguration     | H               |
| B070 | Load Balancer Misconfiguration     | H               |
| B071 | Serverless Function Exposure       | N               |
| B072 | Kubernetes Dashboard Exposure      | N               |
| B073 | Docker Socket Exposure             | P               |
| B074 | Container Breakout                 | P               |
| B075 | IaC Misconfiguration               | S               |
| B076 | CI/CD Pipeline Exposure            | S               |
| B077 | Artifact Poisoning                 | S               |
| B078 | Dependency Hijacking               | S               |
| B079 | Build Process Compromise           | S               |
| B080 | Package Substitution               | S               |
| B081 | Prototype Pollution via JSON       | X               |
| B082 | JWT Algorithm Confusion            | N               |
| B083 | JWT None Algorithm                 | N               |
| B084 | JWT Secret Cracking                | N               |
| B085 | GraphQL Introspection              | N               |
| B086 | GraphQL Query Abuse                | N               |
| B087 | gRPC Misconfigurations             | N               |
| B088 | Webhook Forgery                    | N               |
| B089 | Webhook Replay                     | N               |
| B090 | Race-to-Redeem                     | N               |
| B091 | Double-Spend Logic                 | T               |
| B092 | Concurrent Transactions            | T               |
| B093 | Resource Locking                   | T               |
| B094 | Stored SSRF                        | F               |
| B095 | Blind SSRF                         | F               |
| B096 | DNS-based SSRF                     | F               |
| B097 | Out-of-Band XXE                    | F               |
| B098 | Blind XXE                          | F               |
| B099 | Polyglot Uploads                   | F               |
| B100 | MIME Type Confusion                | F               |
| B101 | Content-Type Spoofing              | F               |
| B102 | ZIP Slip                           | F               |
| B103 | Archive Bombs                      | F               |
| B104 | Symlink Attacks                    | F               |
| B105 | Local Privilege Escalation         | P               |
| B106 | Vertical Privilege Escalation      | O               |
| B107 | Horizontal Privilege Escalation    | O               |
| B108 | Broken RBAC                        | O               |
| B109 | Orphaned Functions                 | O               |
| B110 | Insecure Admin Interfaces          | O               |
| B111 | Shadow APIs                        | O               |
| B112 | Zombie Endpoints                   | O               |
| B113 | Deprecated Endpoints               | O               |
| B114 | Data Residency                     | U               |
| B115 | Data Remanence                     | U               |
| B116 | PII Leakage                        | D               |
| B117 | GDPR Compliance                    | U               |
| B118 | Click Fraud                        | U               |
| B119 | Ad Injection                       | X               |
| B120 | Malvertising                       | X               |
| B121 | Supply Chain Compromise            | S               |
| B122 | Watering Hole Vulnerabilities      | S               |
| B123 | Dependency Vulnerabilities         | S               |
| B124 | Third-Party Script Compromise      | S               |
| B125 | JavaScript Library Vulnerabilities | S               |

## Dependency audit appendix

The production-dependency audit (`npm audit --omit=dev --json`) counts dependency advisories, not confirmed remotely exploitable application defects. It also includes some vendor release/build tooling declared as runtime dependencies. Prioritization must inspect reachability; counts must not be dismissed solely because a dependency is transitive.

- Before: 2 critical, 69 high, 17 moderate, 19 low; 107 total.
- After: 0 critical, 4 high, 42 moderate, 7 low; 53 total.

Full remaining advisory metadata: [dependency report](security-dependencies-2026-11-06.json). Remaining high-severity package entries:

- `@deriv/deriv-charts` — unresolved; see dependency report for affected nodes/advisories.
- `brace-expansion` — unresolved; see dependency report for affected nodes/advisories.
- `lodash.set` — unresolved; see dependency report for affected nodes/advisories.
- `minimatch` — unresolved; see dependency report for affected nodes/advisories.

## Final verification record

- Node 24.19.0: production build passed; locked dependency installation dry run passed. The vendor analytics package still declares Node 18/npm 9 engines; current application regression/build checks pass on Node 24, but vendor compatibility remains a maintenance concern.
- Application regression suite: 63 suites, 442 tests passed.
- Server regression suite with isolated local PostgreSQL 16: 98 tests passed, zero failures/skips. Production PostgreSQL/Render configuration was not inspected.
- Local Chromium: landing page at desktop and mobile widths, live synthetic digit circles, Bot Builder and native Charts loaded with zero recorded CSP violations/runtime errors. Workspace scroll and fixed header checked. No live trading orders were placed.
- Actual production entrypoint smoke check: landing/callback/health succeed, unauthenticated admin access returns 401, and environment/repository/server-source/source-map probes are refused with 404; CSP and private no-store headers verified.
- Credential-format scan: no matches in the supported patterns; this is not a comprehensive secret/history audit.
- Repository-wide TypeScript checking still fails with hundreds of existing baseline diagnostics; this review does not certify a clean typecheck. Tests and the production bundler pass.
- The CSP forbids native string compilation. A build-time adapter replaces one exact static Acorn keyword-check optimization; it fails the build if the expected vendor source changes. Interpreter compatibility is regression-tested with string compilation disabled.
