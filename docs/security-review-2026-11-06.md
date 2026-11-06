# NetoAcademy prelaunch security review — 6 November 2026

**Status: application hardening completed for this pass; unrestricted public launch is NOT cleared.** This is a source review plus local regression/browser testing, not a penetration-test certificate. It does not establish that every vulnerability in the three supplied lists is absent, or that the live Render/DNS/cloud configuration is secure. No attack traffic or trading orders were sent to Deriv, Render or other third parties; dependency metadata was queried from npm/GitHub and the application was tested locally with synthetic trading responses.

## Concrete changes

- Replaced native JavaScript evaluation in tick-delay validation with a bounded numeric parser. Imported bot XML rejects DTDs/entities, oversized input and excessive blocks. Remote XML imports require final HTTPS URLs, omit credentials, reject redirects and limit download size/time.
- Sanitized HTML error messages with an allowlist and updated DOMPurify. Added a CSP that forbids inline scripts/native eval, externalized both startup scripts, added a safe static-keyword adapter for the legacy bot interpreter, replaced the default route stack-trace display with a generic error page, prevented framing, and applied security headers to API/error/static responses. Static delivery blocks repository/config/backup/source/debug paths, verifies realpath containment and streams files instead of buffering whole assets.
- Added bounded HTTP/auth limits, connection quotas including pending handshakes, WebSocket size/message limits and handshake deadlines. Fixed proxy-hop trust, ambiguous query parameters, malformed frame handling and account-rebinding requests. Unknown strategy fields are rejected rather than being mass-assigned.
- Added persistent logout revocation checks across handlers/replicas. Production uses PostgreSQL; file fallback is for one process with durable storage. New trading buys check revocation before forwarding; idle account sockets recheck on their 30-second heartbeat. **HTTPS cookie names now use `__Host-`; existing users must log in again after deployment.**
- Added bounded security event logging without raw IPs, tokens or full URLs. Tightened service-worker caching. Updated maintained Node 24 defaults, pinning of active CI actions, dependency checks and fork-specific CI permissions/scope. Added weekly Dependabot configuration.

## Release requirements still open

1. Keep the local security backports and regression checks maintained. Follow-up remediation cleared all currently reported npm advisories, including development tools; see the updated appendix. The chart and merge fixes include local code that npm cannot certify. A clean audit is not proof of application security.
2. In the existing Render web service, set **NODE_VERSION to `24`**, rebuild, and confirm the running version. Editing render.yaml does not prove an existing service's environment or build command changed. Set its build command to `npm ci --ignore-scripts && npm run build`; confirm it deploys the new commit. Set NETO_ORIGIN to the exact deployed HTTPS origin; register the matching `/callback` in Deriv. Keep NETO_SESSION_SECRET as a stable, server-only cryptographically random secret of at least 32 bytes. Verify NETO_ADMIN_ACCOUNT_IDS contains only the intended owner (`ROT91643925` from this conversation).
3. Use DATABASE_URL for production revocations and analytics, restrict database network access, verify the provider's recommended TLS/certificate settings, and test backup restoration. Without PostgreSQL, an ephemeral Render filesystem cannot preserve logout revocations across replacement instances. Server-tool journals now use PostgreSQL through DATABASE_URL, including a commit barrier before buys and tested restart/reconciliation; see [trading-state persistence](trading-state-persistence.md). Confirm the live service is using that backend. Browser Builder/XML execution and database backup/restore checks remain separate.
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

Removed native Function evaluation from tick-delay validation; numeric-only parsing, input bounds and malicious-expression tests. HTML error messages use an explicit DOMPurify allowlist. JSX renders text normally. CSP blocks inline scripts and native eval. This does not prove every possible XSS/sandbox escape absent; the embedded chart setter and merge-library backports have explicit regression tests and require ongoing maintenance.

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

### S — Supply chain: known audit findings cleared; maintenance required

Updated DOMPurify, Lodash, Handlebars, Router, cookie/XML packages and vendor release-tool dependencies. Node target is maintained 24.x; CI uses verified commit-pinned official actions and npm ci. Legacy Deriv deployments/translation jobs are disabled for this fork. Weekly Dependabot configuration and a supplemental credential-pattern CI check were added. The follow-up cleared known production and development dependency advisories. The embedded chart setter has a checksummed backport, and private compatibility packages replace the unmaintained setter and merge implementation. Tests verify actual consumer resolution and malicious prototype paths. No audit suppression was added; this does not establish a clean supply chain or zero-day protection.

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

Audit counts are advisory metadata, not confirmed remotely exploitable application defects. Production and development dependencies are both reviewed. No advisory exclusions or suppression files were added.

| Review stage                           | Critical | High | Moderate | Low | Total |
| -------------------------------------- | -------- | ---- | -------- | --- | ----- |
| Before first pass, production          | 2        | 69   | 17       | 19  | 107   |
| After first pass, production           | 0        | 4    | 42       | 7   | 53    |
| After follow-up, production            | 0        | 0    | 0        | 0   | 0     |
| After follow-up, including development | 0        | 0    | 0        | 0   | 0     |

Full audit evidence and local-remediation details: [dependency report](security-dependencies-2026-11-06.json).

- Updated patched pattern/brace, date, UUID, XML, Babel and build dependencies. Updated Quill tokens removes unused vendor release tooling, and the unused ShiftAI CLI was removed from this app. Dependency installs in CI/Blueprint disable lifecycle scripts; the production build explicitly applies the reviewed vendor patch.
- `vendor/lodash-set` is a clearly named private compatibility adapter calling maintained `lodash/set`. The vulnerable standalone `lodash.set` implementation is absent. **This alone would not fix SmartCharts:** `scripts/patch-vendor-security.cjs` also backports the prototype-path guard into the actual pinned SmartCharts 2.9.3 bundle, verifies its complete SHA-256, verifies its own patched output on repeat runs, and refuses changed upstream contents. Tests execute the actual embedded factory and verify both ordinary chart-setting paths and attempted prototype pollution.
- `vendor/deepmerge` is an MIT-licensed, explicitly named private fork of 4.3.1, marked `+neto.1`, with source provenance and original checksum. It filters prototype-changing keys from both source and target copying. Tests cover poisoned targets/sources, legitimate merges, options and actual resolution from all tour/build/test consumers. npm cannot inspect/certify a local fork; these tests and source review remain necessary even when its advisory count is zero.
- CI runs `npm audit --audit-level=low` for the complete installed tree, plus regression tests. The locked dependency tree was validated with a fresh install rather than only an audit of a partially updated node_modules directory.

## Final verification record

- Node 24.19.0: production build passed; a complete clean locked dependency installation with lifecycle scripts disabled passed. The vendor analytics package still declares Node 18/npm 9 engines; current application regression/build checks pass on Node 24, but vendor compatibility remains a maintenance concern.
- Application regression suite: 64 suites, 454 tests passed, including spreadsheet-formula regressions.
- Server regression suite with isolated local PostgreSQL 16: 102 tests passed, zero failures/skips. Production PostgreSQL/Render configuration was not inspected.
- Local Chromium: landing page at desktop and mobile widths, live synthetic digit circles, Bot Builder and native Charts loaded with zero recorded CSP violations/runtime errors. Workspace scroll and fixed header checked. No live trading orders were placed.
- Actual production entrypoint smoke check: landing/callback/health succeed, unauthenticated admin access returns 401, and environment/repository/server-source/source-map probes are refused with 404; CSP and private no-store headers verified.
- Credential-format scan: no matches in the supported patterns; this is not a comprehensive secret/history audit.
- Repository-wide TypeScript checking still fails with hundreds of existing baseline diagnostics; this review does not certify a clean typecheck. Tests and the production bundler pass.
- The actual copied/minified chart artifact also passed the prototype-path regression; vendor source maps are omitted and license notices are retained separately.
- The CSP forbids native string compilation. A build-time adapter replaces one exact static Acorn keyword-check optimization; it fails the build if the expected vendor source changes. Interpreter compatibility is regression-tested with string compilation disabled.

## Additional granular review

The additional list is mapped below; repeating a vulnerability name does not establish a new defect. The 15 common-compromise classes repeated at the end of the request map to the first two checklists and the same controls.

### V — Spreadsheet exports: hardened and tested

Journal, transaction and admin CSV exports now share quoting and formula neutralization. Cells beginning with spreadsheet operators (including leading whitespace/control characters) are prefixed as text, embedded quotes/delimiters/newlines remain within a cell, and genuine numeric loss values retain their numeric representation. Journal messages can originate in imported XML, so they must be treated as untrusted text. Downloads use a Blob URL rather than a hand-built data URL.

### Additional evidence and limits

- Static delivery rejects control/null bytes, backslashes, alternate-stream colon syntax, residual double encoding, mixed-case private paths and methods other than GET/HEAD. Local tests exercise these cases, plus encoded traversal and realpath/symlink containment. XML imports reject entity declarations before parsing, so an internal Billion Laughs expansion is refused. Server-side destinations remain fixed Deriv hosts; user XML URLs are fetched by the browser with omitted credentials, not by a server-side proxy.
- Provider account IDs come from Deriv and are compared server-side. No browser-selected account, role, hidden field, local storage marker or account-name homograph grants access. OAuth origins/destinations are fixed rather than derived from Host/forwarded headers. Render/CDN HTTP parsing and DNS/IDN impersonation outside this application still require edge/domain controls.
- Access and refresh tokens stay in encrypted HttpOnly cookies. Browser storage contains account selection, chart/bot state and historical trade metadata, which can still be sensitive on a shared device; it is not a secret vault and is not claimed to be encrypted. Legacy token storage is cleared on session changes. Same-origin XSS/browser-extension compromise is not eliminated by removing tokens from storage.
- Reviewed new-tab links use noopener/noreferrer. CSP and framing protection reduce UI redressing; they do not certify the absence of every cross-origin timing/XS-Leak or browser/hardware side channel. Compression policy is also an edge/provider setting.
- Analytics queues/maps, preview storage and report row counts are bounded; PostgreSQL retention and application quotas reduce application-level abuse. Distributed floods, storage/billing ceilings, disk/DB capacity, alerts and provider budgets still require live operator configuration. Referral/affiliate attribution and anti-fraud controls are provider-owned; no rewards, cart, bookings, subscriptions or user-voting workflow exists here.
- No LLM/RAG/vector database, Java/JNDI/OGNL/RMI, PDF/SSI processor, or self-hosted Redis/MongoDB/Elasticsearch/message broker was found in the reviewed runtime. Bot names containing “AI” do not establish an LLM backend. There is no connected administrative agent tool in the deployed trading application. This is a scope finding, not evidence about an unknown external service.
- Cloud IAM, snapshots, object storage, HSMs, registrar controls and staging/management interfaces were not accessible to inspect. This workspace has no configured Render credentials/connector. These items remain **unverified**, not passed or silently waived. The earlier single-process/distributed-lock requirement still applies.

| ID   | Additional concern                             | Scoped coverage |
| ---- | ---------------------------------------------- | --------------- |
| C001 | Unicode Normalization Attacks                  | F               |
| C002 | Homograph Attacks                              | P               |
| C003 | IDN Spoofing                                   | P               |
| C004 | Path Canonicalization Bypass                   | F               |
| C005 | Alternative Path Traversal                     | F               |
| C006 | Null Byte Injection                            | F               |
| C007 | Wildcard Abuse                                 | R               |
| C008 | Alternate Data Stream (ADS) Abuse              | F               |
| C009 | Case-Sensitivity Bypass                        | F               |
| C010 | File Extension Bypass                          | F               |
| C011 | Double Extension Upload                        | F               |
| C012 | Filename Injection                             | F               |
| C013 | Regular Expression Denial of Service (ReDoS)   | S               |
| C014 | XML Bomb (Billion Laughs)                      | F               |
| C015 | JSON Injection                                 | X               |
| C016 | CSV Injection                                  | V               |
| C017 | Formula Injection                              | V               |
| C018 | PDF Injection                                  | N               |
| C019 | SSI (Server Side Includes) Injection           | N               |
| C020 | Template Sandbox Escape                        | X               |
| C021 | Expression Language Injection                  | X               |
| C022 | OGNL Injection                                 | N               |
| C023 | JNDI Injection                                 | N               |
| C024 | Deserialization Gadget Chains                  | U               |
| C025 | Java RMI Exposure                              | N               |
| C026 | Unsafe Reflection                              | X               |
| C027 | Dynamic Code Evaluation Abuse                  | X               |
| C028 | Prototype Override                             | X               |
| C029 | Client-Side Desynchronization                  | H               |
| C030 | Request Queue Poisoning                        | H               |
| C031 | Host Confusion                                 | H               |
| C032 | Content Spoofing                               | X               |
| C033 | URL Parsing Discrepancies                      | H               |
| C034 | HTTP Verb Tampering                            | O               |
| C035 | Method Override Abuse                          | O               |
| C036 | TRACE Method Enabled                           | H               |
| C037 | WebDAV Misconfiguration                        | N               |
| C038 | Alternate Channel Authentication Bypass        | A               |
| C039 | Privilege Confusion                            | O               |
| C040 | Role Injection                                 | O               |
| C041 | Claims Manipulation                            | A               |
| C042 | Identity Federation Abuse                      | E               |
| C043 | Token Substitution                             | A               |
| C044 | Session Prediction                             | A               |
| C045 | Session Donation                               | A               |
| C046 | Session Swapping                               | A               |
| C047 | Session Riding                                 | A               |
| C048 | Cookie Fixation                                | A               |
| C049 | Cookie Injection                               | A               |
| C050 | Insecure Cookie Scope                          | A               |
| C051 | Domain Cookie Abuse                            | A               |
| C052 | Persistent Authentication Flaws                | A               |
| C053 | Remember-Me Token Abuse                        | A               |
| C054 | CSRF Login Attacks                             | A               |
| C055 | Logout CSRF                                    | A               |
| C056 | Dynamic DNS Abuse                              | P               |
| C057 | Internal Network Exposure                      | P               |
| C058 | Exposed Management Interfaces                  | P               |
| C059 | Exposed Development Endpoints                  | P               |
| C060 | Test Environment Exposure                      | P               |
| C061 | Staging Environment Exposure                   | P               |
| C062 | Preproduction Environment Exposure             | P               |
| C063 | Backup API Exposure                            | P               |
| C064 | Shadow IT Exposure                             | P               |
| C065 | Secret Rotation Failures                       | D               |
| C066 | Key Management Failures                        | D               |
| C067 | Cryptographic Key Reuse                        | A               |
| C068 | Weak Entropy Generation                        | A               |
| C069 | Predictable Nonce Generation                   | A               |
| C070 | Hash Collision Vulnerabilities                 | S               |
| C071 | Unsalted Password Hashes                       | E               |
| C072 | Weak Password Recovery Questions               | E               |
| C073 | Authentication State Confusion                 | A               |
| C074 | Improper Trust Boundaries                      | O               |
| C075 | Trusting Client Input                          | O               |
| C076 | Client-Side Authorization                      | O               |
| C077 | Mobile API Trust Flaws                         | O               |
| C078 | Cross-Tenant Data Leakage                      | O               |
| C079 | Tenant Isolation Failure                       | O               |
| C080 | Shared Resource Exposure                       | O               |
| C081 | Metadata Service Exposure                      | P               |
| C082 | Cloud Instance Takeover                        | P               |
| C083 | IAM Misconfiguration                           | P               |
| C084 | Excessive Permissions                          | P               |
| C085 | Resource Policy Misconfiguration               | P               |
| C086 | Bucket Enumeration                             | P               |
| C087 | Snapshot Exposure                              | P               |
| C088 | Database Snapshot Leakage                      | P               |
| C089 | Exposed Search Indexes                         | P               |
| C090 | Elasticsearch Exposure                         | N               |
| C091 | MongoDB Exposure                               | N               |
| C092 | Redis Exposure                                 | N               |
| C093 | Memcached Exposure                             | N               |
| C094 | Message Queue Exposure                         | N               |
| C095 | RabbitMQ Exposure                              | N               |
| C096 | Kafka Exposure                                 | N               |
| C097 | Graph Database Exposure                        | N               |
| C098 | Data Lake Exposure                             | N               |
| C099 | Object Storage Exposure                        | P               |
| C100 | API Gateway Misconfiguration                   | P               |
| C101 | Reverse Proxy Cache Leaks                      | H               |
| C102 | Internal Header Trust Abuse                    | H               |
| C103 | Rate Limiting Misconfiguration                 | R               |
| C104 | Quota Enforcement Bypass                       | R               |
| C105 | Abuse of Public Endpoints                      | R               |
| C106 | Resource Consumption Attacks                   | R               |
| C107 | Storage Exhaustion Attacks                     | R               |
| C108 | Queue Flooding                                 | R               |
| C109 | Email Flooding                                 | N               |
| C110 | Notification Flooding                          | N               |
| C111 | SMS Flooding                                   | N               |
| C112 | Cost Exhaustion Attacks                        | R               |
| C113 | Billing Abuse                                  | P               |
| C114 | Free-Tier Abuse                                | R               |
| C115 | Business Workflow Manipulation                 | T               |
| C116 | Referral Fraud                                 | E               |
| C117 | Loyalty Program Abuse                          | N               |
| C118 | Gift Card Abuse                                | N               |
| C119 | Reward Point Manipulation                      | N               |
| C120 | Affiliate Abuse                                | E               |
| C121 | Subscription Abuse                             | N               |
| C122 | Trial Abuse                                    | N               |
| C123 | Inventory Manipulation                         | N               |
| C124 | Reservation Race Conditions                    | N               |
| C125 | Booking Logic Flaws                            | N               |
| C126 | Auction Manipulation                           | N               |
| C127 | Reputation System Abuse                        | N               |
| C128 | Voting System Abuse                            | N               |
| C129 | Moderation Bypass                              | N               |
| C130 | Content Filter Bypass                          | N               |
| C131 | AI Prompt Injection                            | N               |
| C132 | Indirect Prompt Injection                      | N               |
| C133 | Retrieval-Augmented Generation (RAG) Poisoning | N               |
| C134 | AI Model Data Leakage                          | N               |
| C135 | AI Training Data Exposure                      | N               |
| C136 | LLM Jailbreak Vulnerabilities                  | N               |
| C137 | Agent Tool Abuse                               | N               |
| C138 | Vector Database Exposure                       | N               |
| C139 | Embedding Poisoning                            | N               |
| C140 | Browser Storage Exposure                       | D               |
| C141 | LocalStorage Token Leakage                     | D               |
| C142 | SessionStorage Exposure                        | D               |
| C143 | IndexedDB Exposure                             | D               |
| C144 | Clipboard Hijacking                            | U               |
| C145 | Tabnabbing                                     | H               |
| C146 | Reverse Tabnabbing                             | H               |
| C147 | UI Redressing                                  | H               |
| C148 | Keystroke Capture via Injection                | X               |
| C149 | Browser Extension Privilege Abuse              | U               |
| C150 | Cross-Origin Information Leakage               | H               |
| C151 | XS-Search                                      | U               |
| C152 | XS-Redirect                                    | U               |
| C153 | XS-Include                                     | U               |
| C154 | Cross-Origin Timing Attacks                    | U               |
| C155 | Side-Channel Information Disclosure            | U               |
| C156 | Cache Timing Attacks                           | U               |
| C157 | Compression Side-Channel Attacks               | P               |
| C158 | Spectre-Class Browser Attacks                  | U               |
| C159 | Rowhammer-Related Exposure                     | U               |
| C160 | Hardware Security Module Misconfiguration      | P               |

## Durable trading-state follow-up

Server-tool state now persists to PostgreSQL when DATABASE_URL is configured. Purchases wait for committed intents; restored runs stay stopped, and unknown outcomes require reconciliation. Tests cover lost acknowledgements and failed settlement saves without duplicate buys/results. Revision checks fence stale state writers but do not replace distributed account locks. The single-process deployment requirement remains. See [operating details and first-deployment precautions](trading-state-persistence.md).

Persistence follow-up validation: 458 application tests and 117 server tests passed, including real isolated PostgreSQL integration checks; production build and startup/shutdown smoke checks passed. Dependency audit remains at zero known advisories. This does not verify the live Render configuration.
