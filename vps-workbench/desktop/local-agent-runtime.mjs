import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonicalLocalDirectory, ensurePrivateDirectory } from './codex-runtime.mjs';
import { antigravityThread } from '../local-sdk/antigravity.mjs';
import { claudeThread } from '../local-sdk/claude.mjs';
import { providerDefaultModels, validLocalApiKey } from '../local-sdk/providers.mjs';

export const claudeKeyVariable = 'VPS_WORKBENCH_LOCAL_CLAUDE_API_KEY';
export const agyPathVariable = 'VPS_WORKBENCH_LOCAL_AGY_EXE';
export const agyHashVariable = 'VPS_WORKBENCH_LOCAL_AGY_SHA256';
const failure = (code) => Object.assign(new Error(code), { code });
const execFileAsync = promisify(execFile);
const drive = /^[a-z]:[\\/]/i;
const binaryPath = (value) => typeof value === 'string' && drive.test(value) && /[\\/]agy[.]exe$/iu.test(value);
const policy = {
  agentMode: '', toolPermission: 'strict', enableTerminalSandbox: true,
  permissions: { deny: ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
};

export function localAgentEnvironment(environment, home, cache, binary, temp = cache) {
  const system = new Map(Object.entries(environment).map(([name, value]) => [name.toUpperCase(), value]));
  const root = system.get('SYSTEMROOT');
  if (!drive.test(root ?? '')) throw failure('invalid_environment');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    .map((key) => [key, system.get(key.toUpperCase())]).filter(([, value]) => typeof value === 'string'));
  return {
    ...env, HOME: home, USERPROFILE: home, APPDATA: cache, LOCALAPPDATA: cache, TEMP: temp, TMP: temp,
    PATH: [dirname(binary), win32.join(root, 'System32')].join(';'), ComSpec: win32.join(root, 'System32', 'cmd.exe'),
    HOMEDRIVE: win32.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
  };
}

async function digestMatches(file, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  try {
    const canonical = await realpath(file);
    if (canonical.toLowerCase() !== resolve(file).toLowerCase() || !(await lstat(file)).isFile()) return false;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex') === expected.toLowerCase();
  } catch { return false; }
}

async function profileDirectories(root, profile) {
  const account = await ensurePrivateDirectory(join(root, 'accounts', profile.id));
  return {
    account,
    temp: await ensurePrivateDirectory(join(root, 'temp', profile.id)),
    cache: await ensurePrivateDirectory(join(root, 'cache', profile.id)),
  };
}

async function configureAntigravity(account) {
  const settings = await ensurePrivateDirectory(join(account, '.gemini', 'antigravity-cli'));
  const file = join(settings, 'settings.json');
  const contents = JSON.stringify(policy);
  try { await writeFile(file, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await lstat(file)).isFile() ||
        JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) !== contents) throw failure('invalid_environment');
  }
}

async function openAgentLogin(binary, directory, env, argumentsLiteral) {
  const command = 'Start-Process -FilePath $env:WORKBENCH_LOGIN_EXE -WorkingDirectory $env:WORKBENCH_LOGIN_DIRECTORY ' +
    '-ArgumentList ' + argumentsLiteral + ' -ErrorAction Stop';
  const powershell = win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      cwd: directory, env: { ...env, WORKBENCH_LOGIN_EXE: binary, WORKBENCH_LOGIN_DIRECTORY: directory },
      windowsHide: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(failure('credential_unavailable')));
  });
}

const openAntigravityLogin = (binary, directory, env) =>
  openAgentLogin(binary, directory, env, '@("acp", "--login", "--disable-telemetry")');
const openClaudeLogin = (binary, directory, env) =>
  openAgentLogin(binary, directory, env, '@("auth", "login", "--claudeai")');

async function readClaudeLogin(binary, directory, env) {
  try {
    const { stdout } = await execFileAsync(binary, ['auth', 'status'], {
      cwd: directory, env, windowsHide: true, timeout: 6000, maxBuffer: 8192,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 1) {
      try {
        if (JSON.parse(error.stdout)?.loggedIn === false) return { loggedIn: false };
      } catch { /* No valid status was available. */ }
    }
    return null;
  }
}

function subscriptionStatus(value, account) {
  if (typeof value?.loggedIn !== 'boolean') return 'unknown';
  if (value.configDirectory !== undefined && (typeof value.configDirectory !== 'string' ||
      win32.resolve(value.configDirectory).toLowerCase() !== win32.resolve(account).toLowerCase())) return 'unknown';
  return value.loggedIn && value.authMethod === 'claude.ai' && value.apiProvider === 'firstParty' &&
    ['pro', 'max', 'ultra', 'team', 'enterprise'].includes(value.subscriptionType) ? 'signed_in' : 'sign_in_required';
}

export async function openLocalAgentRuntime({ backend, runtimeRoot, stateRoot, claudeKey, agyPath, agyHash, sdkEntry,
  environment = process.env, loadClaude = () => sdkEntry ? import(pathToFileURL(sdkEntry).href) : import('@anthropic-ai/claude-agent-sdk'),
  launchLogin = openAntigravityLogin, personalSubscription = false, launchClaudeLogin = openClaudeLogin,
  inspectClaudeLogin = readClaudeLogin,
  isWindowsX64 = process.platform === 'win32' && process.arch === 'x64' }) {
  const claude = backend === 'claude-sdk';
  const binary = claude ? join(runtimeRoot, 'local-claude', 'claude.exe') : agyPath;
  const isFile = async (path) => (await lstat(path).catch(() => null))?.isFile() === true;
  const sdk = claude && isWindowsX64 && await isFile(binary) ? await loadClaude().catch(() => null) : null;
  const runtimeAvailable = isWindowsX64 && (claude ? typeof sdk?.query === 'function' :
    binaryPath(binary) && await digestMatches(binary, agyHash));
  const configured = claude ? validLocalApiKey(backend, claudeKey) : runtimeAvailable;
  const subscriptionAvailable = claude && runtimeAvailable && personalSubscription;
  const credentialConfigured = (profile) => profile?.authMode === 'subscription' ? subscriptionAvailable : Boolean(configured);
  async function claudeEnvironment(profile) {
    const { account, cache, temp } = await profileDirectories(stateRoot, profile);
    const env = { ...localAgentEnvironment(environment, account, cache, binary, temp), CLAUDE_CONFIG_DIR: account,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', DISABLE_AUTOUPDATER: '1' };
    return { account, temp, env };
  }

  async function inspectSubscription(account, env) {
    const value = await inspectClaudeLogin(binary, account, env).catch(() => null);
    return subscriptionStatus(value, account);
  }

  return {
    runtimeAvailable, credentialConfigured, models: providerDefaultModels,
    credentialSource: claude ? 'claude-api-key' : 'agy-local-login',
    accountDirectory: (profileId) => join(stateRoot, 'accounts', profileId),
    ...(subscriptionAvailable && {
      async loginSubscription(profile, canExecute) {
        if (profile.authMode !== 'subscription') return { ok: false, code: 'invalid_profile' };
        if (!canExecute()) return { ok: false, code: 'browse_only' };
        const { account, env } = await claudeEnvironment(profile);
        if (!canExecute()) return { ok: false, code: 'browse_only' };
        await launchClaudeLogin(binary, account, env);
        return { ok: true };
      },
      async checkSubscription(profile, canExecute) {
        if (profile.authMode !== 'subscription') return { ok: false, code: 'invalid_profile' };
        if (!canExecute()) return { ok: false, code: 'browse_only' };
        const { account, env } = await claudeEnvironment(profile);
        if (!canExecute()) return { ok: false, code: 'browse_only' };
        return { ok: true, status: await inspectSubscription(account, env) };
      },
    }),
    ...(!claude && runtimeAvailable && { async login(profile, canExecute) {
      const { account, cache, temp } = await profileDirectories(stateRoot, profile);
      if (!await digestMatches(binary, agyHash)) throw failure('invalid_environment');
      await configureAntigravity(account);
      if (!canExecute()) return { ok: false, code: 'browse_only' };
      await launchLogin(binary, account, localAgentEnvironment(environment, account, cache, binary, temp));
      return { ok: true };
    } }),
    async createThread(profile, nativeId, { interaction, turnId, workspace, bindSession } = {}) {
      if (!runtimeAvailable) throw failure('invalid_environment');
      if (!credentialConfigured(profile)) throw failure('auth_required');
      const registered = await canonicalLocalDirectory(profile.directory);
      if (claude) {
        const { account, temp, env } = await claudeEnvironment(profile);
        const directory = workspace === 'private' ? await ensurePrivateDirectory(join(temp, turnId)) : registered;
        if (profile.authMode === 'subscription') {
          if (await inspectSubscription(account, env) !== 'signed_in') throw failure('auth_required');
        } else {
          env.ANTHROPIC_API_KEY = claudeKey;
        }
        return claudeThread({ query: sdk.query, directory, nativeId, turnId, context: interaction,
          providerOptions: { pathToClaudeCodeExecutable: binary, env } });
      }
      const { account, cache, temp } = await profileDirectories(stateRoot, profile);
      const directory = workspace === 'private' ? await ensurePrivateDirectory(join(temp, turnId)) : registered;
      const env = localAgentEnvironment(environment, account, cache, binary, temp);
      if (!await digestMatches(binary, agyHash)) throw failure('invalid_environment');
      await configureAntigravity(account);
      return antigravityThread({ directory, nativeId, context: interaction, bindSession,
        launch: () => spawn(binary, ['acp', '--sandbox', '--disable-telemetry', '--include-default-customizations=false'], { cwd: directory, env,
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
    },
  };
}
