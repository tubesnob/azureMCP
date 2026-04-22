const http = require('http');
const { URL } = require('url');

const PROTOCOL_VERSION = '2024-11-05';

function parseSseMessage(raw) {
  const lines = raw.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith(':') || line === '') continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

class MCPStreamableHttpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.nextId = 1;
  }

  _post(body, { timeoutMs }) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'POST',
          headers,
        },
        (res) => {
          const sessionHeader = res.headers['mcp-session-id'];
          if (sessionHeader && !this.sessionId) this.sessionId = sessionHeader;
          const contentType = (res.headers['content-type'] || '').toLowerCase();
          const chunks = [];
          res.setEncoding('utf8');
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = chunks.join('');
            if (res.statusCode === 202) {
              resolve(null);
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode} from MCP endpoint: ${text.slice(0, 300)}`));
              return;
            }
            if (contentType.includes('text/event-stream')) {
              const blocks = text.split(/\n\n+/);
              for (const block of blocks) {
                const payload = parseSseMessage(block);
                if (!payload) continue;
                try {
                  const msg = JSON.parse(payload);
                  if (msg && Object.prototype.hasOwnProperty.call(msg, 'result')) {
                    resolve(msg);
                    return;
                  }
                  if (msg && Object.prototype.hasOwnProperty.call(msg, 'error')) {
                    resolve(msg);
                    return;
                  }
                } catch {
                  // skip non-JSON frames
                }
              }
              reject(new Error('SSE response contained no JSON-RPC response message'));
              return;
            }
            if (!text) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(new Error(`Non-JSON response from MCP endpoint: ${text.slice(0, 300)}`));
            }
          });
          res.on('error', reject);
        },
      );
      const to = setTimeout(() => {
        req.destroy(new Error(`MCP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.on('error', (err) => {
        clearTimeout(to);
        reject(err);
      });
      req.on('close', () => clearTimeout(to));
      req.write(body);
      req.end();
    });
  }

  async rpc(method, params, timeoutMs) {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const msg = await this._post(body, { timeoutMs });
    if (!msg) throw new Error(`MCP request "${method}" returned no body`);
    if (msg.error) throw new Error(msg.error.message || `MCP error ${msg.error.code}`);
    return msg.result;
  }

  async notify(method, params, timeoutMs) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this._post(body, { timeoutMs });
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
    await this.notify('notifications/initialized', {}, timeoutMs);
    return result;
  }

  async listTools(timeoutMs) {
    const result = await this.rpc('tools/list', {}, timeoutMs);
    return result?.tools || [];
  }

  async callTool(name, args, timeoutMs) {
    return this.rpc('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  async close(timeoutMs = 5000) {
    if (!this.sessionId) return;
    try {
      await new Promise((resolve) => {
        const u = new URL(this.url);
        const req = http.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': this.sessionId },
        }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
        req.on('error', resolve);
        const to = setTimeout(() => { req.destroy(); resolve(); }, timeoutMs);
        req.on('close', () => clearTimeout(to));
        req.end();
      });
    } catch {
      // best effort
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

async function runTest({ mcpUrl, toolPatterns, toolArgs, summarize, timeoutMs = 30000 }) {
  const client = new MCPStreamableHttpClient(mcpUrl);
  const start = Date.now();
  try {
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
    await client.close();
  }
}

async function testAzureMcp({ mcpPort, timeoutMs }) {
  return runTest({
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    toolPatterns: [/^azmcp[_-]subscription[_-]list$/i, /subscription[_-]list$/i, /subscription$/i],
    toolArgs: {},
    summarize: summarizeSubscriptions,
    timeoutMs,
  });
}

async function testAzureDevOpsMcp({ mcpPort, timeoutMs }) {
  return runTest({
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    toolPatterns: [/^core_list_projects$/i, /list[_-]projects?$/i, /projects?[_-]list$/i],
    toolArgs: {},
    summarize: summarizeProjects,
    timeoutMs,
  });
}

module.exports = {
  MCPStreamableHttpClient,
  testAzureMcp,
  testAzureDevOpsMcp,
};
