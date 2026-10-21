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

Automated checks: 51 Jest tests across 15 suites and 16 Node server tests passed. The production build passed. The original checkout also fails the full TypeScript check (684 diagnostics in the baseline run), so that check is not represented as passing.
