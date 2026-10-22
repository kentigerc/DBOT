require('dotenv').config();
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { createAuthHandler } = require('./auth.cjs');
const { fetch: proxyFetch, ProxyAgent } = require('undici');
const { attachSockets } = require('./socket.cjs');

const development = process.argv.includes('--dev');
const origin =
    process.env.NETO_ORIGIN ||
    (development ? 'http://localhost:5000' : process.env.RENDER_EXTERNAL_URL || 'https://netoacademy.com');
const secret = process.env.NETO_SESSION_SECRET || (development ? randomBytes(48).toString('base64url') : undefined);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
const handleAuth = createAuthHandler({
    origin,
    secret,
    fetchImpl: (url, options) => proxyFetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }),
});
const { createAnalysisService } = require('./analysis.cjs');
const analysis = createAnalysisService(handleAuth, { dispatcher });
const { createBotLoader } = require('./bots.cjs');
const loadBot = createBotLoader(handleAuth);
const root = path.resolve(__dirname, '../dist');
const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml',
};

const server = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/api/bots/load') return loadBot(req, res);
    if (req.url.split('?')[0] === '/api/analysis') return analysis.handle(req, res);
    if (req.url.split('?')[0].startsWith('/api/')) return handleAuth(req, res);
    if (development) {
        res.writeHead(404);
        return res.end();
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        return res.end();
    }
    try {
        const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
        if (pathname === '/bots' || pathname.startsWith('/bots/')) {
            res.writeHead(403);
            return res.end('Bot downloads are disabled.');
        }
        let file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + path.sep) && file !== root) {
            res.writeHead(403);
            return res.end();
        }
        try {
            if (!(await stat(file)).isFile()) file = path.join(root, 'index.html');
        } catch {
            if (path.extname(pathname)) {
                res.writeHead(404);
                return res.end();
            }
            file = path.join(root, 'index.html');
        }
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type':
                (types[path.extname(file)] || 'application/octet-stream') +
                (path.extname(file) === '.html' ? '; charset=utf-8' : ''),
            'Cache-Control': 'no-cache',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
        res.writeHead(400);
        res.end('Unable to serve this request.');
    }
});

attachSockets(server, handleAuth, dispatcher, { analysis });
process.on('SIGTERM', () => {
    analysis.stopAll();
    server.close();
    setTimeout(() => process.exit(0), 10000).unref();
});
server.listen(Number(process.env.PORT || (development ? 3001 : 5000)), development ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`NetoAcademy ${development ? 'API' : 'server'} started.`);
});
