const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AZURE_MCP_BIN = process.env.AZURE_MCP_BIN || 'azmcp';
const ADO_MCP_BIN = process.env.ADO_MCP_BIN || 'mcp-server-azuredevops';
const SUPERGATEWAY_BIN = process.env.SUPERGATEWAY_BIN || 'supergateway';

function readInstalledVersion(pkgName) {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const pkgPath = path.join(globalRoot, pkgName, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    }
  } catch {
    // fall through
  }
  return null;
}

function buildAzureMcpCommand(settings) {
  const inner = [AZURE_MCP_BIN, 'server', 'start'];
  if (settings.cloud && settings.cloud !== 'AzureCloud') {
    inner.push('--cloud', settings.cloud);
  }
  return inner.join(' ');
}

function buildAdoMcpCommand(settings) {
  if (!settings.organization) {
    throw new Error('Azure DevOps organization is not configured.');
  }
  const inner = [ADO_MCP_BIN, settings.organization];
  const auth = settings.authMode === 'pat' ? 'pat' : 'azcli';
  inner.push('-a', auth);
  if (settings.tenantId) inner.push('-t', settings.tenantId);
  if (settings.domains && settings.domains.length > 0) {
    inner.push('-d', ...settings.domains);
  }
  return inner.join(' ');
}

function spawnArgs(ssePort, innerCommand) {
  return [SUPERGATEWAY_BIN, '--stdio', innerCommand, '--port', String(ssePort)];
}

function buildEnv(base, extra) {
  return { ...process.env, ...base, ...(extra || {}) };
}

const DEFINITIONS = {
  'azure-mcp': {
    id: 'azure-mcp',
    label: 'Azure MCP',
    ssePort: Number(process.env.AZURE_MCP_SSE_PORT || 19901),
    packageName: '@azure/mcp',
    settingsKey: 'azureMcp',
    buildSpawn(settings, { deviceAuthDir }) {
      const inner = buildAzureMcpCommand(settings);
      const [cmd, ...args] = spawnArgs(this.ssePort, inner);
      const env = buildEnv(
        {
          AZURE_CONFIG_DIR: deviceAuthDir,
          AZURE_MCP_COLLECT_TELEMETRY: 'false',
        },
        settings.extraEnv,
      );
      return { cmd, args, env };
    },
    version() {
      return readInstalledVersion('@azure/mcp');
    },
  },
  'azure-devops-mcp': {
    id: 'azure-devops-mcp',
    label: 'Azure DevOps MCP',
    ssePort: Number(process.env.ADO_MCP_SSE_PORT || 19902),
    packageName: '@azure-devops/mcp',
    settingsKey: 'azureDevOpsMcp',
    buildSpawn(settings, { deviceAuthDir }) {
      const inner = buildAdoMcpCommand(settings);
      const [cmd, ...args] = spawnArgs(this.ssePort, inner);
      const extra = {
        AZURE_CONFIG_DIR: deviceAuthDir,
        LOG_LEVEL: settings.logLevel || 'info',
      };
      if (settings.authMode === 'pat' && settings.personalAccessToken) {
        extra.PERSONAL_ACCESS_TOKEN = settings.personalAccessToken;
      }
      return { cmd, args, env: buildEnv(extra) };
    },
    version() {
      return readInstalledVersion('@azure-devops/mcp');
    },
  },
};

function list() {
  return Object.values(DEFINITIONS);
}

function get(id) {
  return DEFINITIONS[id];
}

module.exports = {
  DEFINITIONS,
  list,
  get,
  readInstalledVersion,
};
