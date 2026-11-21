import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../helper/relay/RemoteSsh.Proxy.exe', import.meta.url));
const readyText = 'DSH_VPS_RELAY_READY';

export const relayReady = Buffer.from(readyText + '\n', 'ascii');
export const relayRequired = {
  ok: false, code: 'relay_required', message: '请配置已验证且禁止直连的 VPS SSH 中继。',
};

export function readSshRelay(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('relay_required');
  const bytes = readFileSync(join(root, 'ssh-relay.json'));
  if (bytes.length > 1024) throw new Error('relay_required');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || value.version !== 1 ||
      !Number.isInteger(value.socksPort) || value.socksPort < 1 || value.socksPort > 65535 ||
      isIP(value.expectedSshSource) !== 4) throw new Error('relay_required');
  return { socksPort: value.socksPort, expectedSshSource: value.expectedSshSource };
}

export function relayEnvironment(relay) {
  return {
    DSH_VPS_CHAT_SOCKS_PORT: String(relay.socksPort),
    DSH_VPS_CHAT_EXPECTED_SSH_SOURCE: relay.expectedSshSource,
  };
}

export function accountRelayCommand(settings, relay, program) {
  const path = executable.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\/[\p{L}\p{N}_. /-]+$/u.test(path) || isIP(relay?.expectedSshSource) !== 4 ||
      !Number.isInteger(relay.socksPort) || relay.socksPort < 1 || relay.socksPort > 65535)
    throw new Error('relay_required');
  return {
    option: `ProxyCommand="${path}" ${relay.socksPort} ${settings.host} ${settings.port}`,
    remote: 'case "${SSH_CONNECTION-}" in ' + `'${relay.expectedSshSource} '*) printf '%s\\n' '${readyText}'; ${program};; *) exit 41;; esac`,
  };
}
