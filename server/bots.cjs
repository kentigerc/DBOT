const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
function createBotLoader(auth, directory = path.join(__dirname, 'bots')) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        try {
            if (req.method !== 'GET') return end(405, 'Method not allowed.');
            await auth.verifySession(req); // Includes shared logout revocations, not just cookie expiry.
            if (req.headers['sec-fetch-site'] === 'cross-site') return end(403, 'Load bots from NetoAcademy.');
            const file = new URL(req.url, auth.publicOrigin).searchParams.get('file');
            const allowed = await readdir(directory);
            if (!file || !file.endsWith('.xml') || !allowed.includes(file)) return end(404, 'Bot not found.');
            const content = await readFile(path.join(directory, file));
            res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'inline' });
            res.end(content);
        } catch (error) {
            end(
                error.status || 500,
                error.status === 401 ? 'Log in with Deriv to load NetoAcademy bots.' : 'Unable to load this bot.'
            );
        }
        function end(status, error) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error }));
        }
    };
}
module.exports = { createBotLoader };
