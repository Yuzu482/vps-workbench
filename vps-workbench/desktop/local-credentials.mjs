import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from './codex-runtime.mjs';
import { validLocalApiKey } from '../local-sdk/providers.mjs';

const supportedBackend = (backend) => backend === 'codex' || backend === 'claude-sdk';
const failure = (code) => Object.assign(new Error(code), { code });

export function openLocalCredentials({ root, encryption, platform = process.platform }) {
  const available = () => platform === 'win32' && encryption.isEncryptionAvailable();
  const fileFor = (backend) => join(root, backend + '.bin');
  return {
    async read(backend) {
      if (!supportedBackend(backend)) return null;
      const file = fileFor(backend);
      try {
        const item = await lstat(file);
        if (!available() || !item.isFile() || item.size > 8192) return { state: 'unavailable' };
        await ensurePrivateDirectory(root);
        const key = encryption.decryptString(await readFile(file));
        return validLocalApiKey(backend, key) ? { key } : { state: 'unavailable' };
      } catch (cause) {
        return cause.code === 'ENOENT' ? null : { state: 'unavailable' };
      }
    },
    async write(backend, key, canExecute) {
      if (!validLocalApiKey(backend, key)) throw failure('invalid_key');
      if (!available()) throw failure('credential_unavailable');
      await ensurePrivateDirectory(root);
      const encrypted = encryption.encryptString(key);
      const file = fileFor(backend);
      const temporary = join(root, randomUUID() + '.tmp');
      try {
        await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
        if (!canExecute()) throw failure('browse_only');
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
  };
}
