const config = require('../config');
const { logsDirWritable, LOGS_DIR } = require('../logs');

async function gatherDashboard(supervisor) {
  const rows = [];
  for (const s of supervisor.list()) {
    const snap = s.snapshot();
    snap.stats = await s.stats();
    rows.push(snap);
  }
  return rows;
}

function register(app, { supervisor, auth }) {
  app.get('/', async (req, reply) => {
    const servers = await gatherDashboard(supervisor);
    const authStatus = await auth.status();
    return reply.view('dashboard.njk', {
      title: 'Dashboard',
      servers,
      auth: authStatus,
      logsDirWritable: logsDirWritable(),
      logsDir: LOGS_DIR,
    });
  });

  app.get('/servers/:id', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send('not found');
    const settings = config.redact(config.load());
    const snap = s.snapshot();
    snap.stats = await s.stats();
    return reply.view('server-detail.njk', {
      title: s.def.label,
      server: snap,
      settings,
      settingsKey: s.def.settingsKey,
      serverSettings: settings[s.def.settingsKey],
    });
  });

  app.get('/auth', async (req, reply) => {
    const status = await auth.status();
    return reply.view('auth.njk', {
      title: 'Authentication',
      auth: status,
      login: auth.deviceLogin.snapshot(),
    });
  });

  app.get('/settings', async (req, reply) => {
    const settings = config.redact(config.load());
    return reply.view('settings.njk', {
      title: 'Settings',
      settings,
      logsDirWritable: logsDirWritable(),
      logsDir: LOGS_DIR,
    });
  });

  app.get('/about', async (req, reply) => {
    return reply.view('about.njk', { title: 'About' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/partials/servers', async (req, reply) => {
    const servers = await gatherDashboard(supervisor);
    return reply.view('partials/server-cards.njk', { servers });
  });

  app.get('/partials/auth-status', async (req, reply) => {
    const status = await auth.status();
    const login = auth.deviceLogin.snapshot();
    return reply.view('partials/auth-status.njk', { auth: status, login });
  });
}

module.exports = { register };
