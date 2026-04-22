const { spawn } = require('child_process');
const EventEmitter = require('events');
const pidusage = require('pidusage');

const { RingBuffer, createFileSink, attachProcessStreams } = require('./logs');
const servers = require('./servers');

class ServerProcess extends EventEmitter {
  constructor(def, { ringBufferLines, deviceAuthDir, fileLoggingEnabled, logger }) {
    super();
    this.def = def;
    this.logger = logger.child({ server: def.id });
    this.deviceAuthDir = deviceAuthDir;
    this.fileLoggingEnabled = fileLoggingEnabled;
    this.buffer = new RingBuffer(ringBufferLines);
    this.fileSink = fileLoggingEnabled ? createFileSink(def.id) : null;
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.restartCount = 0;
    this.exitCode = null;
    this.version = def.version();
    this.intendedRunning = false;
    this.lastTestResult = null;
    this.testing = false;
  }

  get running() {
    return this.child !== null && this.state === 'running';
  }

  snapshot() {
    return {
      id: this.def.id,
      label: this.def.label,
      ssePort: this.def.ssePort,
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      restartCount: this.restartCount,
      exitCode: this.exitCode,
      lastError: this.lastError,
      version: this.version,
      uptimeMs: this.startedAt && this.state === 'running' ? Date.now() - this.startedAt : 0,
      lastTestResult: this.lastTestResult,
      testing: this.testing,
    };
  }

  async stats() {
    if (!this.child?.pid) return null;
    try {
      const s = await pidusage(this.child.pid);
      return { cpu: s.cpu, memory: s.memory, elapsed: s.elapsed };
    } catch {
      return null;
    }
  }

  async start(settings) {
    if (this.running) return this.snapshot();
    this.intendedRunning = true;
    let spawnPlan;
    try {
      spawnPlan = this.def.buildSpawn(settings, { deviceAuthDir: this.deviceAuthDir });
    } catch (err) {
      this.state = 'error';
      this.lastError = err.message;
      this.emit('state');
      throw err;
    }

    this.lastError = null;
    this.exitCode = null;
    this.state = 'starting';
    this.emit('state');

    const child = spawn(spawnPlan.cmd, spawnPlan.args, {
      env: spawnPlan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.buffer.push(`[supervisor] spawning pid=${child.pid} cmd="${spawnPlan.cmd} ${spawnPlan.args.join(' ')}"`, 'stdout');
    attachProcessStreams(child, this.buffer, this.fileSink);

    child.on('error', (err) => {
      this.lastError = err.message;
      this.buffer.push(`[supervisor] spawn error: ${err.message}`, 'stderr');
      this.state = 'error';
      this.child = null;
      this.stoppedAt = Date.now();
      this.emit('state');
    });

    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.buffer.push(`[supervisor] exited code=${code} signal=${signal}`, 'stderr');
      this.child = null;
      this.stoppedAt = Date.now();
      this.state = this.intendedRunning ? 'crashed' : 'stopped';
      this.emit('state');
    });

    this.state = 'running';
    this.emit('state');
    return this.snapshot();
  }

  async stop({ timeoutMs = 5000 } = {}) {
    this.intendedRunning = false;
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      this.emit('state');
      return this.snapshot();
    }
    this.state = 'stopping';
    this.emit('state');
    this.buffer.push('[supervisor] sending SIGTERM', 'stdout');
    child.kill('SIGTERM');
    const killed = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (!killed && this.child) {
      this.buffer.push('[supervisor] SIGTERM timeout, sending SIGKILL', 'stderr');
      try {
        this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    return this.snapshot();
  }

  async restart(settings) {
    this.restartCount += 1;
    await this.stop();
    return this.start(settings);
  }
}

class Supervisor {
  constructor({ settings, deviceAuthDir, fileLoggingEnabled, logger }) {
    this.logger = logger;
    this.settings = settings;
    this.servers = new Map();
    for (const def of servers.list()) {
      this.servers.set(
        def.id,
        new ServerProcess(def, {
          ringBufferLines: settings.ui?.ringBufferLines ?? 10000,
          deviceAuthDir,
          fileLoggingEnabled,
          logger,
        }),
      );
    }
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  get(id) {
    return this.servers.get(id);
  }

  list() {
    return Array.from(this.servers.values());
  }

  settingsFor(id) {
    const def = servers.get(id);
    if (!def) return null;
    return this.settings[def.settingsKey];
  }

  async startAll() {
    for (const s of this.servers.values()) {
      const cfg = this.settingsFor(s.def.id);
      if (cfg?.enabled && cfg?.autoStart) {
        try {
          await s.start(cfg);
        } catch (err) {
          this.logger.warn({ err: err.message, server: s.def.id }, 'autoStart failed');
        }
      }
    }
  }

  async stopAll() {
    await Promise.all(Array.from(this.servers.values()).map((s) => s.stop()));
  }
}

module.exports = { Supervisor, ServerProcess };
