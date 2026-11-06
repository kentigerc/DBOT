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
        pathname === '/test-offline.html'
    );
}
async function serveStatic(req, res, { root, origin }) {
    if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        return res.end();
    }
    try {
        const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
        if (privatePath(pathname)) {
            res.writeHead(404);
            return res.end();
        }
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
        const canonicalRoot = await realpath(root);
        file = await realpath(file);
        if (!file.startsWith(canonicalRoot + path.sep)) {
            res.writeHead(403);
            return res.end();
        }
        const size = (await stat(file)).size;
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
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
