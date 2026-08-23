// Registers /healthz (public, mounted before auth) and /api/health (auth-exempt).
function registerHealthzRoute(app, { APP_VERSION }) {
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', version: APP_VERSION });
  });
}

function registerApiHealthRoute(app, { APP_VERSION }) {
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: APP_VERSION });
  });
}

module.exports = { registerHealthzRoute, registerApiHealthRoute };
