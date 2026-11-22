import { lstat, mkdir, mkdtemp, readdir, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validLocalApiKey } from '../local-sdk/providers.mjs';

export const localCredentialVariable = 'VPS_WORKBENCH_LOCAL_CODEX_API_KEY';
export const localModels = Object.freeze([
  { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
]);

const systemVariables = ['SystemRoot', 'WINDIR', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN'];
const error = (code) => Object.assign(new Error(code), { code });
const localDrivePath = /^[a-z]:[\\/]/i;

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function canonicalLocalDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) ||
      (process.platform === 'win32' && !localDrivePath.test(directory))) throw error('invalid_directory');
  try {
    const normalized = resolve(directory);
    const canonical = await realpath(normalized);
    if (!(await lstat(normalized)).isDirectory() || !samePath(canonical, normalized)) throw error('invalid_directory');
    return canonical;
  } catch {
    throw error('invalid_directory');
  }
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return canonicalLocalDirectory(directory);
}

function createEnvironment(source, home, temp, vendor) {
  const parent = new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]));
  const windows = parent.get('SYSTEMROOT');
  if (!localDrivePath.test(windows ?? '')) throw error('invalid_environment');
  const env = Object.fromEntries(systemVariables
    .map((key) => [key, parent.get(key.toUpperCase())]).filter(([, value]) => typeof value === 'string'));
  env.ComSpec = win32.join(windows, 'System32', 'cmd.exe');
  env.PATH = [join(vendor, 'codex-path'), win32.join(windows, 'System32'),
    win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  return { ...env, CODEX_HOME: home, TEMP: temp, TMP: temp };
}

function projectTrustOverride(directory) {
  const entries = [];
  for (let path = directory; ; path = dirname(path)) {
    entries.push(`${JSON.stringify(path)} = { trust_level = "untrusted" }`);
    if (path === dirname(path)) return 'projects = { ' + entries.join(', ') + ' }';
  }
}

function stageInputs(thread, temp) {
  return {
    async runStreamed(input, options) {
      const files = [];
      const directory = await mkdtemp(join(temp, 'turn-media-'));
      const clean = async () => {
        await Promise.allSettled(files.map((path) => unlink(path)));
        await rmdir(directory).catch(() => {});
      };
      try {
        const staged = [];
        for (const item of input) {
          options.signal?.throwIfAborted();
          if (item.type === 'text') {
            staged.push(item);
            continue;
          }
          if (item.type !== 'raster' || !['png', 'jpeg', 'webp'].includes(item.format) ||
              !Buffer.isBuffer(item.bytes) || item.bytes.length > 512 * 1024) throw error('invalid_environment');
          const path = join(directory, files.length + '.' + item.format);
          await writeFile(path, item.bytes, { flag: 'wx', mode: 0o600 });
          files.push(path);
          staged.push({ type: 'local_image', path });
        }
        const { events } = await thread.runStreamed(staged, options);
        return { events: (async function* () {
          try { yield* events; } finally { await clean(); }
        })() };
      } catch (cause) {
        await clean();
        throw cause;
      }
    },
  };
}

export function localMcpOverride(servers) {
  return 'mcp_servers = { ' + servers.map(({ id, local: { url, tools } }) =>
    JSON.stringify(id) + ' = { url = ' + JSON.stringify(url) + ', enabled_tools = ' + JSON.stringify(tools) +
      ', startup_timeout_sec = 5, tool_timeout_sec = 30 }').join(', ') + ' }';
}

export async function openCodexRuntime({ runtimeRoot, stateRoot, apiKey, sdkEntry, environment = process.env,
  loadSdk = () => sdkEntry ? import(pathToFileURL(sdkEntry).href) : import('@openai/codex-sdk'),
  isWindowsX64 = process.platform === 'win32' && process.arch === 'x64' }) {
  const vendor = join(runtimeRoot, 'local-codex');
  const binary = join(vendor, 'bin', 'codex.exe');
  const credentialConfigured = validLocalApiKey('codex', apiKey);
  const staged = isWindowsX64 && (await stat(binary).catch(() => null))?.isFile() === true;
  const sdk = staged ? await loadSdk().catch(() => null) : null;
  const Codex = sdk?.Codex;
  const runtimeAvailable = typeof Codex === 'function';
  return {
    runtimeAvailable,
    credentialConfigured: () => credentialConfigured,
    async createThread(profile, threadId, { workspace, sessionId, rasterInput, mcpServers = [], verbosity } = {}) {
      if (!credentialConfigured) throw error('auth_required');
      if (!runtimeAvailable) throw error('invalid_environment');
      // Recheck each run so a replaced directory cannot redirect an existing profile.
      const registered = await canonicalLocalDirectory(profile.directory);
      const directory = workspace === 'private'
        ? await ensurePrivateDirectory(join(stateRoot, 'workspaces', profile.id, sessionId)) : registered;
      if (workspace === 'private' && (await readdir(directory)).length) throw error('invalid_directory');
      const home = await ensurePrivateDirectory(join(stateRoot, 'threads', profile.id));
      const temp = await ensurePrivateDirectory(join(stateRoot, 'temp', profile.id));
      // Project trust and private SDK state are separate from the user's regular Codex configuration.
      // Refuse injected per-user settings in the managed home. System policy files still load normally.
      for (const name of ['config.toml', 'auth.json', '.env', 'hooks.json']) {
        try {
          await lstat(join(home, name));
          throw error('invalid_environment');
        } catch (cause) {
          if (cause.code !== 'ENOENT') throw error('invalid_environment');
        }
      }
      const codex = new Codex({
        apiKey, baseUrl: 'https://api.openai.com/v1', codexPathOverride: binary,
        env: createEnvironment(environment, home, temp, vendor),
        // A quoted inline table preserves drive letters, backslashes and dots in Windows keys.
        configOverrides: [projectTrustOverride(directory), localMcpOverride(mcpServers)],
        config: {
          model_provider: 'openai', forced_login_method: 'api', cli_auth_credentials_store: 'keyring',
          ...(verbosity && { model_verbosity: verbosity }),
          windows: { sandbox: 'unelevated' }, check_for_update_on_startup: false,
          shell_environment_policy: { inherit: 'none', ignore_default_excludes: false },
          features: { apps: false, plugins: false, memories: false, memory_tool: false,
            multi_agent: false, multi_agent_v2: false, skip_host_skill_discovery: true,
            skill_mcp_dependency_install: false, system_proxy_fallback: false,
            ...(workspace === 'private' && { shell_tool: false, unified_exec: false, shell_snapshot: false }) },
        },
      });
      const options = {
        workingDirectory: directory, sandboxMode: 'read-only', approvalPolicy: 'never',
        skipGitRepoCheck: true, networkAccessEnabled: false, webSearchMode: 'disabled',
        model: profile.model, modelReasoningEffort: profile.effort,
      };
      const thread = threadId ? codex.resumeThread(threadId, options) : codex.startThread(options);
      return rasterInput ? stageInputs(thread, temp) : thread;
    },
  };
}
