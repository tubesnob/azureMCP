const http = require('http');
const { URL } = require('url');

const PROTOCOL_VERSION = '2024-11-05';

function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let event = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith(':') || line === '') continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !event) return null;
  return { event: event || 'message', data: dataLines.join('\n') };
}

function resolveEndpoint(sseUrl, endpointData) {
  return new URL(endpointData, sseUrl).toString();
}

class MCPClient {
  constructor(sseUrl) {
    this.sseUrl = sseUrl;
    this.messageUrl = null;
    this.sseReq = null;
    this.sseRes = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.readyPromise = null;
  }

  connect(timeoutMs) {
    this.readyPromise = new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        reject(new Error('SSE connect timed out waiting for endpoint event'));
        this.close();
      }, timeoutMs);

      const req = http.get(
        this.sseUrl,
        { headers: { Accept: 'text/event-stream' } },
        (res) => {
          if (res.statusCode !== 200) {
            clearTimeout(to);
            reject(new Error(`SSE connect failed with HTTP ${res.statusCode}`));
            res.resume();
            this.close();
            return;
          }
          this.sseRes = res;
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.replace(/\r\n/g, '\n');
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const raw = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const ev = parseSseEvent(raw);
              if (!ev) continue;
              if (ev.event === 'endpoint' && !this.messageUrl) {
                this.messageUrl = resolveEndpoint(this.sseUrl, ev.data.trim());
                clearTimeout(to);
                resolve();
              } else if (ev.event === 'message') {
                this._onMessage(ev.data);
              }
            }
          });
          res.on('end', () => this._failAll(new Error('SSE stream ended')));
          res.on('error', (err) => this._failAll(err));
        },
      );
      req.on('error', (err) => {
        clearTimeout(to);
        reject(err);
      });
      this.sseReq = req;
    });
    return this.readyPromise;
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id == null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timeout);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  _failAll(err) {
    if (this.closed) return;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.pending.clear();
    this.close();
  }

  _post(body) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.messageUrl);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 400) {
            reject(new Error(`POST to MCP endpoint failed with HTTP ${res.statusCode}`));
          } else {
            resolve();
          }
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async rpc(method, params, timeoutMs) {
    if (!this.messageUrl) throw new Error('MCP client not connected');
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    await this._post(body);
    return promise;
  }

  async notify(method, params) {
    if (!this.messageUrl) throw new Error('MCP client not connected');
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this._post(body);
  }

  async initialize(timeoutMs) {
    const result = await this.rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tubesnob-azuremcp-supervisor', version: '0.1.0' },
      },
      timeoutMs,
    );
    await this.notify('notifications/initialized', {});
    return result;
  }

  async listTools(timeoutMs) {
    const result = await this.rpc('tools/list', {}, timeoutMs);
    return result?.tools || [];
  }

  async callTool(name, args, timeoutMs) {
    return this.rpc('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sseReq?.destroy();
    } catch {
      // ignore
    }
  }
}

function pickTool(tools, patterns) {
  for (const pattern of patterns) {
    const hit = tools.find((t) => pattern.test(t.name));
    if (hit) return hit;
  }
  return null;
}

function textFromToolResult(result) {
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text || '')
      .join('\n');
  }
  return '';
}

function tryParseJson(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function summarizeSubscriptions(parsed, text) {
  const list =
    (Array.isArray(parsed) && parsed) ||
    parsed?.subscriptions ||
    parsed?.results?.subscriptions ||
    parsed?.results ||
    null;
  if (!Array.isArray(list)) {
    return { count: null, preview: text.slice(0, 500) };
  }
  const preview = list
    .slice(0, 5)
    .map((s) => s.displayName || s.name || s.subscriptionId || s.id || '(unnamed)')
    .join(', ');
  return { count: list.length, preview };
}

function summarizeProjects(parsed, text) {
  const list =
    (Array.isArray(parsed) && parsed) ||
    parsed?.value ||
    parsed?.projects ||
    parsed?.results ||
    null;
  if (!Array.isArray(list)) {
    return { count: null, preview: text.slice(0, 500) };
  }
  const preview = list
    .slice(0, 5)
    .map((p) => p.name || p.displayName || p.id || '(unnamed)')
    .join(', ');
  return { count: list.length, preview };
}

async function runTest({ sseUrl, toolPatterns, toolArgs, summarize, timeoutMs = 30000 }) {
  const client = new MCPClient(sseUrl);
  const start = Date.now();
  try {
    await client.connect(timeoutMs);
    await client.initialize(timeoutMs);
    const tools = await client.listTools(timeoutMs);
    const tool = pickTool(tools, toolPatterns);
    if (!tool) {
      const names = tools.map((t) => t.name).slice(0, 20).join(', ');
      throw new Error(`No MCP tool matched ${toolPatterns[0]}. Available (first 20): ${names || '<none>'}`);
    }
    const callResult = await client.callTool(tool.name, toolArgs, timeoutMs);
    if (callResult?.isError) {
      const msg = textFromToolResult(callResult) || 'tool reported isError';
      throw new Error(msg.slice(0, 500));
    }
    const text = textFromToolResult(callResult);
    const parsed = tryParseJson(text);
    const { count, preview } = summarize(parsed, text);
    return {
      ok: true,
      tool: tool.name,
      count,
      preview,
      durationMs: Date.now() - start,
    };
  } finally {
    client.close();
  }
}

async function testAzureMcp({ ssePort, timeoutMs }) {
  return runTest({
    sseUrl: `http://127.0.0.1:${ssePort}/sse`,
    toolPatterns: [/^azmcp[_-]subscription[_-]list$/i, /subscription[_-]list$/i, /subscription$/i],
    toolArgs: {},
    summarize: summarizeSubscriptions,
    timeoutMs,
  });
}

async function testAzureDevOpsMcp({ ssePort, project, timeoutMs }) {
  return runTest({
    sseUrl: `http://127.0.0.1:${ssePort}/sse`,
    toolPatterns: [/^core_list_projects$/i, /list[_-]projects?$/i, /projects?[_-]list$/i],
    toolArgs: project ? { project } : {},
    summarize: summarizeProjects,
    timeoutMs,
  });
}

module.exports = {
  MCPClient,
  testAzureMcp,
  testAzureDevOpsMcp,
};
