const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.BUNDLE_CONFIG_DIR || '/config';
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

const DEFAULTS = Object.freeze({
  azureMcp: {
    enabled: true,
    autoStart: true,
    cloud: 'AzureCloud',
    extraEnv: {},
  },
  azureDevOpsMcp: {
    enabled: true,
    autoStart: true,
    organization: '',
    authMode: 'azcli',
    personalAccessToken: '',
    tenantId: '',
    domains: ['all'],
    logLevel: 'info',
  },
  ui: {
    fileLogging: true,
    ringBufferLines: 10000,
  },
});

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function load() {
  ensureConfigDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    return structuredClone(DEFAULTS);
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return deepMerge(structuredClone(DEFAULTS), parsed);
}

function save(settings) {
  ensureConfigDir();
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + os.EOL, { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_PATH);
}

function redact(settings) {
  const copy = structuredClone(settings);
  if (copy.azureDevOpsMcp?.personalAccessToken) {
    copy.azureDevOpsMcp.personalAccessToken = '***REDACTED***';
  }
  return copy;
}

module.exports = {
  CONFIG_DIR,
  SETTINGS_PATH,
  DEFAULTS,
  load,
  save,
  redact,
};
