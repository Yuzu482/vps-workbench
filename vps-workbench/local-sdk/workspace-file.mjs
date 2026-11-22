import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const privateName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[.]|$)|(?:^|[-_.])(?:credentials?|secrets?|tokens?|keychain|id_rsa|id_ed25519|known_hosts)(?:[-_.]|$)|[.](?:pem|key|pfx|p12)$/iu;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function workspaceFile(root, path) {
  if (typeof path !== 'string' || !path.length || path.length > 1024 || /[\p{Cc}\p{Cf}*?"<>|]/u.test(path) || /^[/\\]{2}/u.test(path)) return null;
  const parts = path.replace(/^[A-Za-z]:/u, '').split(/[/\\]/u).filter(Boolean);
  if (parts.some((part) => part === '..' || part.includes(':'))) return null;
  const target = resolve(root, path);
  const name = relative(root, target);
  if (!name || isAbsolute(name) || name.startsWith('..' + sep) || name === '..' || name.length > 512 ||
      name.split(sep).some((part) => part.startsWith('.') || /[. ]$/u.test(part) || privateName.test(part))) return null;
  try {
    const [canonical, entry] = await Promise.all([realpath(target), lstat(target)]);
    if (!samePath(canonical, target) || !entry.isFile() || entry.nlink !== 1 || entry.size > 512 * 1024) return null;
    return { target, name };
  } catch { return null; }
}
