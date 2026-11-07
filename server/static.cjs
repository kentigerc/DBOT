const { stat, realpath } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml',
    '.wasm': 'application/wasm',
};
function privatePath(pathname) {
    return (
        pathname.split('/').some(part => part.startsWith('.')) ||
        /^\/(?:src|server|node_modules)(?:\/|$)/i.test(pathname) ||
        /\.(?:map|bak|old|orig|zip|tar|tgz|gz|sql|sqlite|db|log|env|ini|ya?ml|lock|cjs|[cm]?tsx?)$/i.test(pathname) ||
        pathname.toLowerCase() === '/test-offline.html'
    );
}
async function serveStatic(req, res, { root, origin, authorizeAdmin }) {
    if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        return res.end();
    }
    try {
        const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
        if (/[\x00-\x1f\x7f\\:]/.test(pathname) || /%[a-f0-9]{2}/i.test(pathname)) {
            res.writeHead(400);
            return res.end();
        }
        if (privatePath(pathname)) {
            res.writeHead(404);
            return res.end();
        }
        const adminPage = /^\/admin(?:\/|$)/i.test(pathname);
        if (adminPage) {
            res.setHeader('Vary', 'Cookie');
            let allowed = false;
            if (authorizeAdmin) {
                try {
                    await authorizeAdmin(req);
                    allowed = true;
                } catch {
                    // Private routes are indistinguishable from missing pages.
                }
            }
            if (!allowed) {
                const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | NetoAcademy</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#efefea;font:16px/1.6 system-ui,sans-serif}main{text-align:center;padding:32px;max-width:480px}strong{color:#ff514e;font-size:64px}h1{font-size:32px;margin:8px 0}p{color:#b4b4ae}a{display:inline-block;padding:12px 20px;margin-top:12px;border:1px solid #ffffff40;border-radius:8px;color:inherit;text-decoration:none}a:focus-visible{outline:2px solid #ff514e;outline-offset:4px}</style></head><body><main><strong>404</strong><h1>Page not found</h1><p>The page you’re looking for isn’t available.</p><a href="/">Return to homepage</a></main></body></html>`;
                res.writeHead(404, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'private, no-store',
                    'Content-Length': Buffer.byteLength(body),
                });
                return res.end(req.method === 'HEAD' ? undefined : body);
            }
        }
        if (pathname.toLowerCase() === '/bots' || pathname.toLowerCase().startsWith('/bots/')) {
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
        const canonicalRoot = await realpath(root);
        file = await realpath(file);
        if (!file.startsWith(canonicalRoot + path.sep)) {
            res.writeHead(403);
            return res.end();
        }
        const size = (await stat(file)).size;
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': adminPage ? 'private, no-store' : 'no-cache',
            'Content-Length': size,
        });
        if (req.method === 'HEAD') res.end();
        else await pipeline(createReadStream(file), res);
    } catch {
        if (res.headersSent || res.destroyed) {
            res.destroy();
            return;
        }
        res.writeHead(400);
        res.end('Unable to serve this request.');
    }
}
module.exports = { serveStatic, privatePath };
