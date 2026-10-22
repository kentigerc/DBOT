# NetoAcademy

NetoAcademy uses application ID `34JTY4LLFlIghrMont8RN` and the production callback `https://netoacademy.com/callback`. Public registration values live in `config/netoacademy.json`. There is no frontend client secret.

## What is connected

- Login starts at `/api/auth/login` and uses Deriv's OAuth authorization-code flow with S256 PKCE and a random state.
- The callback sends the authorization code to our server. Only the server exchanges it at `https://auth.deriv.com/oauth2/token`.
- Sessions use encrypted HttpOnly cookies with SameSite=Lax and Secure on HTTPS. Tokens are not returned to the browser or saved in localStorage. Sessions expire after at most one hour; users must log in again.
- `/api/session` returns account metadata. Demo accounts are selected first when no selection exists. Each account connection is checked against the user's Deriv account list.
- `/api/socket` bridges public or account-scoped WebSockets. Account OTPs and access tokens stay on the server. Connections require the site's exact Origin, respect session expiry, and use bounded buffers and heartbeat checks.
- The wire adapter translates new API symbol fields, account-scoped balances, proposal parameters and string amounts for the existing bot engine. Unsupported trade-timing parameters fail explicitly rather than silently changing a strategy.
- Sign-up links use the supplied Deriv tracking URL unchanged. Markup/affiliate eligibility and rates are controlled by Deriv's partner programme and dashboard; this code does not invent an affiliate token or guarantee earnings for existing accounts.

The editable legacy endpoint form, Deriv-owned TMB/OIDC login flow and automatic loading of the bundled Deriv LiveChat, Survicate, Hotjar, Intercom and GTM integrations are no longer used by this workflow. Font and UI token styles are bundled locally.

## Develop

Use Node 20 as required by this checkout:

```sh
npm ci
npm run dev
```

The development command starts the API on port 3001 and Rsbuild on port 5000, including a WebSocket proxy. Use `http://localhost:5000` to match the development Origin. A session encryption key is generated in memory for development; restarting the API signs out local sessions.

For a full local login, register `http://localhost:5000/callback` as an additional allowed callback in Deriv. Keep `https://netoacademy.com/callback` registered for production. Do not enter API tokens, passwords or private keys into source files or chat.

```sh
npm run test:server
npm test -- --ci --maxWorkers=2
npm run build
```

Do not run a build concurrently with the development server: they may share generated output paths. The legacy `test:lint` script rewrites files; use ESLint without `--fix` for a read-only check.

## Deploy on Render

`render.yaml` selects Render's Free plan for previewing the site, with WebSocket support and an automatically generated session secret. Free services sleep when idle; use an always-on paid plan for continuous trading.

1. Connect the repository's `main` branch to a Render Blueprint and confirm the plan says Free before deploying.
2. Render builds with `npm ci && npm run build` and starts `npm run start:production`.
3. The server automatically uses Render's `RENDER_EXTERNAL_URL` as its origin. If you previously set `NETO_ORIGIN=https://netoacademy.com`, remove that override for the preview. Keep the generated `NETO_SESSION_SECRET` private and persistent.
4. Copy the actual HTTPS `.onrender.com` address from Render. In the Deriv dashboard, register that exact address followed by `/callback` for the OAuth2 app with the `trade` scope.
5. Open the Render address, log in yourself, select a demo account, import a bot and test a demo trade through its lifecycle before allowing real trading. Confirm partner attribution/markup in the Deriv dashboard.
6. When the custom domain is registered, add it in Render, configure its DNS and set `NETO_ORIGIN=https://netoacademy.com`. Keep the production callback registered in Deriv.

The static-only Cloudflare/Vercel configurations inherited from the template do not run this backend. Use the Render service for this integration.

For another Node host, build then run `npm start`, set `NETO_ORIGIN` and a private `NETO_SESSION_SECRET` of at least 32 bytes, route HTTPS and WebSocket upgrades to its `PORT`, and preserve cookies. `/api/health` is the health-check path. TLS verification remains enabled for Deriv requests; the server supports an HTTPS proxy through `HTTPS_PROXY` when present.

## Bot compatibility

Hosted XML files are imported only after the builder workspace is ready. Existing imports also accept the exact standard-shaped `apollo_purchase` and `btnotify` aliases as Purchase and Notify blocks. XML with extra unsupported inputs is rejected. No trading or risk-control blocks are silently dropped.

The Accumulators Pro file contains custom `set_tp` and `set_sl` blocks without their implementations. Its load button is unavailable until a compatible export or those implementations are supplied. Recreating stop-loss/take-profit behavior from those empty block names would be guesswork.

## Validation limits

The application ID was checked against the real Deriv authorization endpoint: it redirects to sign-in, while an invalid control ID returns `invalid_client`. Real public market data and contract metadata were retrieved through the server bridge. Production-mode local browser checks exercised the branded interface and Blockly workspace, imported all 11 available hosted bots with their expected names and block counts, and uploaded a local XML file through My computer and Open. The App ID flow and public market-data checks used real Deriv endpoints; authenticated server tests used controlled upstream responses. Automated server tests use controlled upstream responses for authenticated behavior; adapter tests cover documented schema changes.

No owner credentials were requested. Full user login, live account discovery, demo/real trade execution, payout calculations and commission attribution are not verified until the owner completes the deployed login and demo-account checks. No real-money orders were placed. The repository's full TypeScript check has existing failures; production compilation and the test suites are separate checks.

Official references: https://developers.deriv.com/docs/intro/oauth/ , https://developers.deriv.com/docs/options/websocket/ , https://developers.deriv.com/comparison/

Automated checks: 82 Jest tests across 20 suites and 26 Node server tests passed. The production build passed. The original checkout also fails the full TypeScript check (684 diagnostics in the baseline run), so that check is not represented as passing.

## Analysis Tool strategy

The native Analysis Tool replaces the external iframe. Its digit entry filters and ten recovery modes are adapted from the supplied `DerivDigitStrategy-20261013-201516-294b962c.zip` Python source. No uploaded credentials or session files are used. Default controls are a $0.35 starting stake, five consecutive losses, a $100 maximum stake per trade and a separate $100 session stop-loss. Advanced controls retain the source's default $5 take-profit (zero disables it), one-tick duration and filtered Under 5 recovery with a three-digit formation and a configurable martingale multiplier defaulting to 2.1×, with stakes rounded to cents. The multiplier accepts values of at least 1 with up to two decimal places and is locked during a session. Older saved sessions inherit 2.1×.

RUN executes on the Node server using the selected USD account and a dedicated authenticated socket. The Render Free preview permits new demo entries only. The dashboard shows digit frequencies, recovery state, results and entry/exit spots; the terminal can be opened or closed independently. STOP prevents new orders and monitors an existing contract through settlement. The session stop-loss also reserves the proposed next stake, preventing a purchase whose full loss would exceed the limit.

Connected devices poll the same account session every second. Start on one device, view the same dashboard and execution terminal on another, and press STOP from either. Closing the initiating browser does not stop the server engine. Concurrent starts are rejected. The authenticated server verifies account ownership for status and commands; browser tokens and private OTP URLs are never included in snapshots. Builder purchase requests are blocked while that account has a server Analysis Tool session or unresolved purchase.

The server journals purchase intent synchronously before each buy, retains counters and pending contracts, and never automatically resumes entries after a restart. An uncertain purchase is never retried; reconcile its contract ID from Deriv history. Unresolved purchases saved by the previous browser version can be imported into the server for explicit reconciliation. New session resets counters only after purchases settle. A login's expiry stops new entries. Open contracts remain monitored until settlement when the connection is available.

This implementation supports **one Node server instance**. Render Free has ephemeral storage and can suspend or restart: this is a demo preview, not reliable unattended hosting. A restart within retained storage restores pending intent; a redeploy or disk loss can remove session history. Fresh starts check Deriv's portfolio and reject existing open contracts. Stop the bot before deployments. For reliable operation, use an always-on single instance with a persistent disk, set `NETO_ANALYSIS_STATE_DIR` to that disk, preserve `NETO_SESSION_SECRET`, and complete demo lifecycle checks. Only then explicitly enable new real entries with `NETO_ANALYSIS_ALLOW_REAL=true`. Multiple server replicas require a shared transactional store and distributed execution lock before use.

Validation includes 77 Jest tests across 18 suites and a browser simulation of a normal loss, recovery win, terminal interaction, manual stop and mobile layouts. Simulated trades do not verify authenticated Deriv execution; perform an owner-controlled demo trade before real trading.

Two isolated browser contexts additionally verified shared running state, duplicate RUN prevention, continued simulated execution after the initiating browser closed, terminal access and STOP from the second device. These checks used the actual server strategy engine with a local simulated Deriv upstream.

## Embedded Deriv Charts

The former Tutorials tab now hosts `https://charts.deriv.com/deriv` inside an iframe under `#deriv_charts`; older `#tutorial` links resolve to this tab. The frame is sized to the available viewport, the mobile Builder controls are hidden on this tab, and Reload chart refreshes only the frame. Its sandbox permits scripts, forms and downloads while preventing top-level navigation.

Local browser checks verified the URL, tab label, reload behavior and layouts at 320, 390 and 768 pixels with a local frame fixture. Live embedding was not verified: this workspace's outbound policy denies `charts.deriv.com`, so its current CSP and X-Frame-Options headers could not be inspected. Deriv must permit framing for the external chart to display on the deployed site; no proxy or header-stripping workaround is used.

Responsive follow-up checks exercised repeated 390 → 1440 → 320 → 1366 → 768 → 1440 pixel transitions. The chart wrapper stretches with its flex parent, the mobile scroll lock is cleaned up on desktop, and the iframe remains mounted throughout resizing to preserve chart state. Frame bounds and scroll cleanup were verified using the local frame fixture; the production build passed.

Deriv Charts fits its iframe to the visible space beneath the toolbar rather than forcing a 640px minimum that could hide lower indicators. The height calculation respects clipping containers, fixed footer controls and visual viewport changes, and reserves at least 8px of bottom padding plus the device safe area when larger. Expand chart uses the visible browser viewport; Exit expanded view restores the normal layout. The iframe stays mounted while expanding and resizing. Local frame checks covered visible bottom edges without outer scrolling across seven phone, tablet, landscape and desktop sizes in normal, expanded and restored views; the production build passed.

After its first visit, the Deriv Charts tab remains mounted while other application tabs are active. Its iframe and live connection are retained, and its viewport styling is disabled in the background so Bot Builder behaves normally. Three local fixture round trips to Bot Builder preserved the chart document, sample annotations and selected market while simulated ticks continued. This preserves analysis within the current open page; a full page refresh, logout, closing the page or Reload chart can still reset chart state. It does not synchronize chart annotations across devices.

Digit Analysis also remains mounted after its first visit. Switching tabs preserves its selected market, sample size, rolling digit window and public tick subscription. Only its viewport styling is disabled while hidden. Three simulated round trips to Bot Builder retained R_50 and the 100-tick sample, continued receiving ticks in the background and avoided new history requests. The production build passed.

Free Bots uses a viewport-bounded, keyboard-focusable scrolling region instead of extending beyond the clipped desktop container. Browser checks confirmed mouse-wheel scrolling at 1280, 1440 and 1920 pixel desktop widths and 390 pixel mobile width, access to the last bot's load button and keyboard End scrolling. The production build passed.

The application header is fixed to the top of the viewport across all sections. The layout reserves its measured responsive height, including wrapped mobile navigation, so content is not covered. Desktop/mobile browser checks verified inner-list scrolling, document scrolling, section switching, content offsets and header stacking; the production build passed.

## Hosted bot export restrictions

Hosted XML is stored under `server/bots`, outside the public build. `/api/bots/load` requires a valid Deriv session, serves only allowlisted files and returns private/no-store responses. Old `/bots/` download URLs are refused. Users must log in to load hosted bots; personal file uploads remain available.

Hosted files carry export provenance in the XML and non-procedure block metadata. Blockly serialization retains that provenance after edits and ordinary block copies. The normal Save dialog, local XML export, Download Block and Google Drive saving refuse protected strategies with a clear message; no invalid or misleading file is generated. Protected strategies are excluded from Recent/autosave storage and retained in memory when moving between sections. An explicit personal-strategy replacement or Reset restores normal export behavior. Transaction and journal downloads are unaffected.

**This is a browser-level export restriction, not DRM or strategy secrecy.** Authorized browsers receive the XML and blocks, so a technical user can inspect, copy or alter them and remove these checks. Files already downloaded, older browser caches and XML in repository history cannot be revoked. If the repository is public, its current files and historical bot files remain accessible independently of the site; making the repository private is a separate owner action. True strategy confidentiality requires server execution with no strategy source or complete blocks sent to clients.

Validation: all 11 supported hosted bots loaded with provenance and refused Save, including standalone/mobile imports; metadata comparison preserved generated output or the same fixture-dependent metadata error. These code-generation checks did not execute trades. A protected strategy survived a tab round trip in memory, while replacing it with a personal default allowed an actual local XML export in a browser test. Endpoint tests cover authentication, path traversal, cross-site loading and no-store headers. All 82 application tests, 26 server tests and the production build passed.

Over Punisher was added from the uploaded NETO OVER ENHANCED AUTO C4 XML under Over/Under, using the same hosted export restrictions. Desktop/mobile browser imports succeeded, Save was refused, and the protected and unmarked variants generated identical trading code. No trades or Telegram notifications were executed. The production build and all 26 server tests passed.

Over Punisher's password gate was removed while retaining its successful setup routine. Seven Blockly mutation elements supplied in the HTML namespace were normalized to the Blockly namespace; this restores dynamic inputs and the startup call to Trade that previously fell back to its block ID and raised an undefined-reference error. Two regression tests verify function references and password-free setup. Desktop/mobile browser imports resolve all function calls and generate code without a prompt; all 26 server tests passed. No trades were executed. Reload the bot from Free Bots to replace an older open workspace.

The uploaded Deriv Balanced Random With Three High Digits Under4 bot now replaces Even & Odd AI Bot as Over Punisher. The previous Over Punisher is renamed Over 1/Over 0 and retains its earlier fixes. Both hosted XML files have password gates removed, successful initialization preserved, seven malformed mutation namespaces corrected, and hosted export restrictions retained. The removed Even & Odd XML is no longer available through the private loader. Four startup regression tests and all 26 server tests passed, together with the production build. Desktop and mobile browser checks loaded both bots, resolved every procedure call, confirmed no generated password prompt and blocked Save; protection metadata did not change generated trading code. No trades or Telegram notifications were executed.

Free Bots now contains only Over Punisher, Over 1/Over 0, and the newly uploaded Under Punisher. The eleven remaining legacy catalog entries and their hosted XML files were removed. Under Punisher retains the uploaded trading logic, with its password gate removed, successful initialization preserved, seven malformed mutation namespaces corrected, and hosted export protection applied. Its catalog description is neutral. All six startup regression tests, 26 server tests, and the production build passed. Desktop/mobile browser checks confirmed the three-card catalog, Under Punisher import, resolved function references, no generated password prompt, and Save refusal. Protection metadata preserves generated trading code. No trades or Telegram messages were executed.
