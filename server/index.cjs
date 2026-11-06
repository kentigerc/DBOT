require('dotenv').config();
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { createSecurity } = require('./security.cjs');
const { serveStatic } = require('./static.cjs');
const { createAuthHandler } = require('./auth.cjs');
const revocations = require('./revocations.cjs').createRevocations();
const { fetch: proxyFetch, ProxyAgent } = require('undici');
const { attachSockets } = require('./socket.cjs');

const development = process.argv.includes('--dev');
const origin =
    process.env.NETO_ORIGIN ||
    (development ? 'http://localhost:5000' : process.env.RENDER_EXTERNAL_URL || 'https://netoacademy.com');
const secret = process.env.NETO_SESSION_SECRET || (development ? randomBytes(48).toString('base64url') : undefined);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
let admin;
let analysis;
const handleAuth = createAuthHandler({
    origin,
    secret,
    onAccounts: values => admin?.accounts(values),
    revocations,
    fetchImpl: (url, options) => proxyFetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }),
});
const { createAnalysisService } = require('./analysis.cjs');
const { createAnalyticsStore } = require('./analytics-store.cjs');
const { createAdminAnalytics } = require('./admin.cjs');
let analyticsStore;
try {
    analyticsStore = createAnalyticsStore();
} catch {
    console.error('Analytics storage could not initialize; trading remains available.');
    analyticsStore = {
        mode: 'unavailable',
        health: () => false,
        put: async () => {
            throw new Error('Storage unavailable');
        },
        list: async () => {
            throw new Error('Storage unavailable');
        },
        prune: async () => {},
        close: async () => {},
    };
}
admin = createAdminAnalytics({
    auth: handleAuth,
    store: analyticsStore,
    secret,
    activeBots: () =>
        [...(analysis?.sessions.values() || [])].filter(value => value.engine.getSnapshot().active).length,
});
analysis = createAnalysisService(handleAuth, {
    dispatcher,
    onTrade: (account, state, packet) =>
        admin.trade(
            account.account_id,
            state.settings.strategy === 'momentum-70'
                ? 'momentum_70'
                : state.settings.strategy === 'even-odd'
                  ? 'even_odd'
                  : state.settings.strategy === 'over2-under7'
                    ? 'hit_and_run'
                    : 'analysis_tool',
            packet
        ),
});
const { createBotLoader } = require('./bots.cjs');
const loadBot = createBotLoader(handleAuth);
const root = path.resolve(__dirname, '../dist');
const security = createSecurity({ origin, secret, sessionIdentity: handleAuth.sessionIdentity });
const server = http.createServer(
    { headersTimeout: 15000, requestTimeout: 30000, maxHeaderSize: 16384 },
    async (req, res) => {
        if (!security.handle(req, res)) return;
        if (req.url.split('?')[0].startsWith('/api/admin/') || req.url.split('?')[0] === '/api/analytics/pulse')
            return admin.handle(req, res);
        if (req.url.split('?')[0] === '/api/bots/load') return loadBot(req, res);
        if (req.url.split('?')[0] === '/api/analysis') return analysis.handle(req, res);
        if (req.url.split('?')[0].startsWith('/api/')) return handleAuth(req, res);
        if (development) {
            res.writeHead(404);
            return res.end();
        }
        return serveStatic(req, res, { root, origin });
    }
);

attachSockets(server, handleAuth, dispatcher, {
    analysis,
    security,
    onConnection: (account, key, open) => admin.connection(account, key, open),
    onTrade: (account, value) => admin.trade(account, 'bot_builder', value),
});
process.on('SIGTERM', () => {
    analysis.stopAll();
    void admin.close().catch(() => {});
    void revocations.close().catch(() => {});
    server.close();
    setTimeout(() => process.exit(0), 10000).unref();
});
server.listen(Number(process.env.PORT || (development ? 3001 : 5000)), development ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`NetoAcademy ${development ? 'API' : 'server'} started.`);
});
