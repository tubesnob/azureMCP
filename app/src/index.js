const path = require('path');
const Fastify = require('fastify');
const pino = require('pino');
const nunjucks = require('nunjucks');

const config = require('./config');
const auth = require('./auth');
const { Supervisor } = require('./supervisor');
const { logsDirWritable } = require('./logs');
const uiRoutes = require('./routes/ui');
const apiRoutes = require('./routes/api');
const sseRoutes = require('./routes/sse');

const HTTP_PORT = Number(process.env.PORT || 19900);
const HTTP_HOST = process.env.BIND_HOST || '0.0.0.0';

async function main() {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  auth.ensureAuthDir();

  let settings = config.load();
  config.save(settings); // normalize on disk

  const fileLoggingEnabled = !!settings.ui?.fileLogging && logsDirWritable();
  const deviceLogin = new auth.DeviceCodeLogin();

  const supervisor = new Supervisor({
    settings,
    deviceAuthDir: auth.DEVICE_AUTH_DIR,
    fileLoggingEnabled,
    logger,
  });

  const authApi = {
    status: auth.status,
    logout: auth.logout,
    deviceLogin,
  };

  const app = Fastify({ logger });
  await app.register(require('@fastify/formbody'));
  await app.register(require('@fastify/view'), {
    engine: { nunjucks },
    root: path.join(__dirname, '..', 'views'),
    viewExt: 'njk',
    options: {
      autoescape: true,
      noCache: process.env.NODE_ENV !== 'production',
    },
  });
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
  });

  uiRoutes.register(app, { supervisor, auth: authApi });
  apiRoutes.register(app, {
    supervisor,
    auth: authApi,
    saveSettings: (s) => {
      config.save(s);
      settings = s;
    },
  });
  sseRoutes.register(app, { supervisor, auth: authApi });

  deviceLogin.on('update', (snap) => {
    if (snap.finished && snap.success) {
      logger.info('Azure sign-in completed; auto-starting configured servers.');
      supervisor.startAll().catch((err) => logger.warn({ err }, 'autoStart after login failed'));
    }
  });

  await app.listen({ host: HTTP_HOST, port: HTTP_PORT });
  logger.info({ host: HTTP_HOST, port: HTTP_PORT }, 'Management UI listening');

  const initialAuth = await auth.status().catch(() => ({ signedIn: false }));
  if (initialAuth.signedIn) {
    await supervisor.startAll().catch((err) => logger.warn({ err }, 'initial startAll failed'));
  } else {
    logger.info('Not signed in to Azure; MCP servers will remain stopped until sign-in completes.');
  }

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    try {
      await Promise.race([
        supervisor.stopAll(),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    } finally {
      await app.close().catch(() => {});
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal', err);
  process.exit(1);
});
