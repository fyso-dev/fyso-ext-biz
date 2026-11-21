// Login routes for Fyso Biz, behind the project's web login (Caddy `fyso_login`).
// GET /login starts PKCE; GET /callback stores the grant and returns to the panel page.
const http = require('node:http'), crypto = require('node:crypto');
const {store, addresses} = require('./auth.cjs');

const TTL = 10 * 60 * 1000, COOKIE = 'fyso_biz_login';

function server({env = process.env, auth = store({env}), now = Date.now} = {}) {
  const pending = new Map();
  const sweep = () => { for (const [key, value] of pending) if (now() - value.at > TTL) pending.delete(key); };
  const page = (res, status, key) => {
    res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    // Plain status page; the panel page explains the error in the person's language.
    res.end(`<!doctype html><meta charset="utf-8"><title>Fyso Biz</title><p>Fyso Biz: ${key}</p><p><a href="${addresses(env).page}">Fyso</a></p>`);
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(204).end(); return; }
      if (req.method === 'GET' && url.pathname === '/login') {
        sweep();
        const request = await auth.begin(addresses(env).callback);
        const binding = crypto.randomBytes(24).toString('base64url');
        pending.set(request.state, {...request, binding, at: now()});
        res.writeHead(302, {Location: request.url, 'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=${binding}; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=600`});
        res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/callback') {
        const state = url.searchParams.get('state') || '', entry = pending.get(state);
        pending.delete(state);
        const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
        if (!entry || now() - entry.at > TTL || !cookie || cookie !== entry.binding) { page(res, 400, 'invalid_callback'); return; }
        if (url.searchParams.get('error')) { page(res, 400, 'access_denied'); return; }
        await auth.finish(entry, url.searchParams.get('code'));
        res.writeHead(302, {Location: addresses(env).page, 'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=0`});
        res.end(); return;
      }
      res.writeHead(404).end();
    } catch (error) {
      const known = ['invalid_origin', 'connection_failed', 'oauth_not_supported', 'registration_failed', 'access_denied', 'remote_unavailable', 'invalid_callback'];
      page(res, 502, known.includes(error.message) ? error.message : 'connection_failed');
    }
  });
}

/** The panel API on the private socket the framework routes /api/ext/biz/ to (D79). */
function listenPrivate(handler, socket) {
  const fs = require('node:fs');
  // Owner-only from the first instant: the socket is created under this umask.
  fs.rmSync(socket, {force: true});
  const previous = process.umask(0o177);
  const private_ = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(204).end(); return; }
    handler(req, res);
  });
  return new Promise((resolve, reject) => private_.once('error', reject).listen(socket, () => {
    process.umask(previous); fs.chmodSync(socket, 0o600); resolve(private_);
  }));
}

module.exports = {server, listenPrivate};
if (require.main === module) {
  const port = Number(process.env.FYSO_EXT_BIZ_PORT);
  if (!port) { console.error('FYSO_EXT_BIZ_PORT is required'); process.exit(1); }
  require("./email.cjs").startReceiver();
  server().listen(port, '127.0.0.1', () => console.log(`Fyso Biz login on 127.0.0.1:${port}`));
  // Older frameworks do not pass a socket; the panel then reads through Dagu.
  const socket = process.env.FYSO_EXT_SOCKET;
  if (socket) listenPrivate(require('./api.cjs').api(), socket).then(() => console.log(`Fyso Biz panel API on ${socket}`), error => { console.error(`Fyso Biz panel API: ${error.message}`); process.exit(1); });
}
