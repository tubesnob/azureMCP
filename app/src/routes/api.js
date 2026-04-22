const config = require('../config');
const mcpClient = require('../mcp-client');

const TEST_TIMEOUT_MS = 30000;

async function collectSnapshot(supervisor) {
  const rows = [];
  for (const s of supervisor.list()) {
    const snap = s.snapshot();
    snap.stats = await s.stats();
    snap.sseUrl = `/mcp/${s.def.id}/sse`;
    snap.directSseUrl = `http://<host>:${s.def.ssePort}/sse`;
    rows.push(snap);
  }
  return rows;
}

function register(app, { supervisor, auth, saveSettings }) {
  app.get('/api/servers', async () => {
    return { servers: await collectSnapshot(supervisor) };
  });

  app.get('/api/servers/:id', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const snap = s.snapshot();
    snap.stats = await s.stats();
    snap.sseUrl = `/mcp/${s.def.id}/sse`;
    snap.directSseUrl = `http://<host>:${s.def.ssePort}/sse`;
    return snap;
  });

  app.post('/api/servers/:id/start', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const cfg = supervisor.settingsFor(req.params.id);
    try {
      await s.start(cfg);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    return { ok: true, state: s.state };
  });

  app.post('/api/servers/:id/stop', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    await s.stop();
    return { ok: true, state: s.state };
  });

  app.post('/api/servers/:id/restart', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const cfg = supervisor.settingsFor(req.params.id);
    try {
      await s.restart(cfg);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    return { ok: true, state: s.state };
  });

  app.post('/api/servers/:id/test', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    if (!s.running) {
      return reply.code(400).send({ error: 'server is not running' });
    }
    if (s.testing) {
      return reply.code(409).send({ error: 'a test is already running' });
    }
    s.testing = true;
    s.emit('state');
    const startedAt = Date.now();
    try {
      let result;
      if (s.def.id === 'azure-mcp') {
        result = await mcpClient.testAzureMcp({
          ssePort: s.def.ssePort,
          timeoutMs: TEST_TIMEOUT_MS,
        });
      } else if (s.def.id === 'azure-devops-mcp') {
        const cfg = supervisor.settingsFor(s.def.id);
        result = await mcpClient.testAzureDevOpsMcp({
          ssePort: s.def.ssePort,
          project: cfg?.organization,
          timeoutMs: TEST_TIMEOUT_MS,
        });
      } else {
        return reply.code(400).send({ error: 'no test defined for this server' });
      }
      s.lastTestResult = {
        ok: true,
        ranAt: startedAt,
        durationMs: result.durationMs,
        tool: result.tool,
        count: result.count,
        preview: result.preview,
      };
      s.emit('state');
      return { ok: true, ...s.lastTestResult };
    } catch (err) {
      s.lastTestResult = {
        ok: false,
        ranAt: startedAt,
        durationMs: Date.now() - startedAt,
        error: err.message || String(err),
      };
      s.emit('state');
      return reply.code(500).send({ ok: false, error: s.lastTestResult.error });
    } finally {
      s.testing = false;
      s.emit('state');
    }
  });

  app.post('/api/servers/:id/config', async (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });

    const settings = config.load();
    const key = s.def.settingsKey;
    const body = req.body || {};
    const current = settings[key];

    if (s.def.id === 'azure-mcp') {
      current.enabled = body.enabled === 'on' || body.enabled === true;
      current.autoStart = body.autoStart === 'on' || body.autoStart === true;
      if (body.cloud) current.cloud = body.cloud;
      if (body.tenantId !== undefined) current.tenantId = String(body.tenantId).trim();
      if (body.subscriptionId !== undefined) current.subscriptionId = String(body.subscriptionId).trim();
    } else if (s.def.id === 'azure-devops-mcp') {
      current.enabled = body.enabled === 'on' || body.enabled === true;
      current.autoStart = body.autoStart === 'on' || body.autoStart === true;
      if (body.organization !== undefined) current.organization = String(body.organization).trim();
      if (body.tenantId !== undefined) current.tenantId = String(body.tenantId).trim();
      if (body.authMode) current.authMode = body.authMode;
      if (body.logLevel) current.logLevel = body.logLevel;
      if (body.domains !== undefined) {
        const raw = Array.isArray(body.domains) ? body.domains : String(body.domains).split(/[\s,]+/);
        current.domains = raw.map((d) => d.trim()).filter(Boolean);
        if (current.domains.length === 0) current.domains = ['all'];
      }
      if (typeof body.personalAccessToken === 'string' && body.personalAccessToken !== '' && body.personalAccessToken !== '***REDACTED***') {
        current.personalAccessToken = body.personalAccessToken;
      }
    }

    settings[key] = current;
    saveSettings(settings);
    supervisor.updateSettings(settings);

    let restarted = false;
    if (s.running) {
      try {
        await s.restart(current);
        restarted = true;
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    }
    return { ok: true, restarted };
  });

  app.get('/api/auth/status', async () => {
    const s = await auth.status();
    return { ...s, login: auth.deviceLogin.snapshot() };
  });

  app.post('/api/auth/login', async () => {
    auth.deviceLogin.start();
    return { ok: true };
  });

  app.post('/api/auth/cancel', async () => {
    auth.deviceLogin.cancel();
    return { ok: true };
  });

  app.post('/api/auth/logout', async () => {
    await auth.logout();
    return { ok: true };
  });

  app.get('/api/settings', async () => {
    return config.redact(config.load());
  });

  app.post('/api/settings', async (req) => {
    const settings = config.load();
    const body = req.body || {};
    settings.ui = settings.ui || {};
    if (body.fileLogging !== undefined) settings.ui.fileLogging = body.fileLogging === 'on' || body.fileLogging === true;
    if (body.ringBufferLines) settings.ui.ringBufferLines = Math.max(100, Math.min(100000, Number(body.ringBufferLines)));
    saveSettings(settings);
    supervisor.updateSettings(settings);
    return { ok: true };
  });
}

module.exports = { register };
