const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { CONFIG_DIR } = require('./config');

const AZ_BIN = process.env.AZ_BIN || 'az';
const DEVICE_AUTH_DIR = path.join(CONFIG_DIR, 'azure');

function ensureAuthDir() {
  fs.mkdirSync(DEVICE_AUTH_DIR, { recursive: true });
}

function runAz(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      AZ_BIN,
      args,
      {
        env: { ...process.env, AZURE_CONFIG_DIR: DEVICE_AUTH_DIR },
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', err });
      },
    );
  });
}

async function status() {
  ensureAuthDir();
  const res = await runAz(['account', 'show', '--output', 'json']);
  if (res.code !== 0) {
    return { signedIn: false };
  }
  try {
    const acct = JSON.parse(res.stdout);
    return {
      signedIn: true,
      user: acct.user?.name || null,
      tenantId: acct.tenantId || null,
      subscription: acct.name || null,
      subscriptionId: acct.id || null,
      environmentName: acct.environmentName || null,
    };
  } catch {
    return { signedIn: false };
  }
}

class DeviceCodeLogin extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.child = null;
    this.active = false;
    this.lastMessage = null;
    this.finished = false;
    this.success = null;
    this.stderrBuffer = '';
  }

  snapshot() {
    return {
      active: this.active,
      finished: this.finished,
      success: this.success,
      lastMessage: this.lastMessage,
    };
  }

  start() {
    if (this.active) return;
    ensureAuthDir();
    this.active = true;
    this.finished = false;
    this.success = null;
    this.lastMessage = 'Starting device-code login…';
    this.stderrBuffer = '';
    this.emit('update', this.snapshot());

    const child = spawn(AZ_BIN, ['login', '--use-device-code', '--output', 'json'], {
      env: { ...process.env, AZURE_CONFIG_DIR: DEVICE_AUTH_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const onText = (chunk, stream) => {
      const text = chunk.toString('utf8');
      this.stderrBuffer += text;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        this.lastMessage = line;
        this.emit('update', { ...this.snapshot(), stream });
      }
    };
    child.stdout.on('data', (c) => onText(c, 'stdout'));
    child.stderr.on('data', (c) => onText(c, 'stderr'));

    child.on('error', (err) => {
      this.active = false;
      this.finished = true;
      this.success = false;
      this.lastMessage = `az login spawn error: ${err.message}`;
      this.emit('update', this.snapshot());
    });

    child.on('exit', (code) => {
      this.active = false;
      this.finished = true;
      this.success = code === 0;
      this.lastMessage =
        code === 0 ? 'Login succeeded.' : `az login exited with code ${code}.`;
      this.child = null;
      this.emit('update', this.snapshot());
    });
  }

  cancel() {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}

async function logout() {
  ensureAuthDir();
  return runAz(['logout']);
}

module.exports = {
  DEVICE_AUTH_DIR,
  ensureAuthDir,
  status,
  logout,
  DeviceCodeLogin,
};
