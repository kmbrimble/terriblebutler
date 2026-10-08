// /healthz (public, mounted before auth) and /api/health (auth-exempt) answer status only: the
// exact version tells an unauthenticated caller which known flaws to try. /api/health adds the
// version when the caller presents a valid credential.
function registerHealthzRoute(app) {
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });
}

function registerApiHealthRoute(app, { APP_VERSION, authenticateToken }) {
  app.get('/api/health', (req, res) => {
    const [scheme, token] = (req.headers['authorization'] || '').split(' ');
    const body = { status: 'ok' };
    if (scheme === 'Bearer' && token && authenticateToken(token)) body.version = APP_VERSION;
    res.json(body);
  });
}

module.exports = { registerHealthzRoute, registerApiHealthRoute };
