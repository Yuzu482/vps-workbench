import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as untar } from 'tar';
import { componentCatalog } from './component-catalog.mjs';
import { canonicalLocalDirectory, ensurePrivateDirectory } from './codex-runtime.mjs';
import { stageClaude } from './stage-claude.mjs';
import { stageCodex } from './stage-codex.mjs';

const limit = 384 * 1024 * 1024;
const stampName = 'verified-component.json';
const platformSupported = () => process.platform === 'win32' && process.arch === 'x64';
const error = (code) => Object.assign(new Error(code), { code });
const integrityDigest = /^[A-Za-z0-9+/]{86}==$/u;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const runtimeModule = {
  codex: 'node_modules/@openai/codex-sdk/dist/index.js',
  'claude-sdk': 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
};

export function validComponentSelection(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 && new Set(value).size === value.length &&
    value.every((id) => typeof id === 'string' && Object.hasOwn(componentCatalog, id));
}

async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

async function download(source, file, request, signal) {
  const url = new URL(source.url);
  const trusted = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    (url.origin === 'https://registry.npmjs.org' ||
      url.origin === 'https://storage.googleapis.com' && url.pathname.startsWith('/antigravity-public/antigravity-cli/'));
  if (!trusted || !integrityDigest.test(source.integrity)) throw error('component_source_invalid');
  const operation = AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]);
  const hash = createHash('sha512');
  let length = 0;
  try {
    const response = await request(url.href, { signal: operation, redirect: 'error', credentials: 'omit' });
    if (response.status !== 200 || !response.body) throw error('component_download_failed');
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      length += chunk.length;
      if (length > (source.bytes ?? limit)) return callback(error('component_integrity_failed'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(file, { flags: 'wx' }), { signal: operation });
  } catch (cause) {
    if (signal.aborted) throw error('component_cancelled');
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(cause.code)) throw error('component_storage_failed');
    throw error(cause.code === 'component_integrity_failed' ? cause.code : 'component_download_failed');
  }
  if (hash.digest('base64') !== source.integrity || (source.bytes !== undefined && length !== source.bytes)) {
    throw error('component_integrity_failed');
  }
}

async function extract(archive, directory) {
  await mkdir(directory, { recursive: true });
  let unsafe = false, count = 0, bytes = 0;
  const seen = new Set();
  try {
    await untar({ file: archive, cwd: directory, strip: 1, strict: true, preservePaths: false,
      filter(path, entry) {
        const names = path.replace(/\/$/u, '').split('/');
        bytes += entry.size;
        const key = path.replace(/\/$/u, '').toLowerCase();
        const safe = names.shift() === 'package' && ['File', 'Directory'].includes(entry.type) &&
          names.length <= 32 && !seen.has(key) &&
          ++count <= 4096 && bytes <= 2 * limit && names.every((part) => part && !/[\\:*?"<>|\p{Cc}]|[. ]$/u.test(part) &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[.]|$)/iu.test(part));
        if (safe) seen.add(key);
        else unsafe = true;
        return safe;
      },
    });
    if (unsafe) throw error('component_archive_invalid');
  } catch { throw error('component_archive_invalid'); }
}

async function fingerprint(root) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0, count = 0;
  async function scan(prefix, directory, depth) {
    if (depth > 32) throw error('component_integrity_failed');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name === right.name ? 0 : 1)) {
      if (!prefix && entry.name === stampName) continue;
      const file = join(directory, entry.name);
      const path = prefix + entry.name;
      if (++count > 4096) throw error('component_integrity_failed');
      if (entry.isDirectory()) await scan(path + '/', file, depth + 1);
      else if (entry.isFile()) {
        bytes += (await lstat(file)).size;
        if (bytes > 2 * limit) throw error('component_integrity_failed');
        files++;
        hash.update(`${path}\0${await digest(file)}\n`);
      } else throw error('component_integrity_failed');
    }
  }
  await scan('', root, 0);
  if (!files) throw error('component_integrity_failed');
  return hash.digest('hex');
}

export function createComponentInstaller({ root, catalog = componentCatalog, request = (...args) => fetch(...args), supported = platformSupported(),
  stage = { codex: stageCodex, 'claude-sdk': stageClaude } }) {
  const pending = new Map();
  function pin(backend) {
    if (!Object.hasOwn(catalog, backend) || !Object.hasOwn(componentCatalog, backend)) throw error('invalid_component');
    return catalog[backend];
  }
  function destination(backend) { return join(root, backend, pin(backend).version); }

  async function installed(backend) {
    const source = pin(backend);
    const target = destination(backend);
    try {
      await canonicalLocalDirectory(target);
      const header = join(target, stampName);
      const meta = await lstat(header);
      if (!meta.isFile() || meta.size > 4096) return null;
      const stamp = JSON.parse(await readFile(header, 'utf8'));
      if (stamp.version !== source.version || stamp.backend !== backend) return null;
      if (backend === 'antigravity') {
        const agyPath = join(target, 'agy.exe');
        const metadata = await lstat(agyPath);
        if (!metadata.isFile() || metadata.size !== source.binary.bytes ||
            await digest(agyPath, 'sha512') !== source.binary.integrity) return null;
        return { agyPath, agyHash: await digest(agyPath) };
      }
      if (stamp.content !== source.content || await fingerprint(target) !== source.content) return null;
      const sdkEntry = join(target, runtimeModule[backend]);
      if (!(await lstat(sdkEntry)).isFile()) return null;
      return { sdkEntry, runtimeRoot: join(target, 'helper') };
    } catch { return null; }
  }

  async function provision(backend, signal) {
    if (!supported) throw error('component_platform_unavailable');
    if (signal.aborted) throw error('component_cancelled');
    const available = await installed(backend);
    if (available) return available;
    const source = pin(backend);
    const target = destination(backend);
    const parent = await ensurePrivateDirectory(dirname(target));
    const temporary = await mkdtemp(join(parent, '.install-'));
    const payload = join(temporary, 'payload');
    try {
      await mkdir(payload);
      if (source.binary) {
        await download(source.binary, join(payload, 'agy.exe'), request, signal);
      } else {
        const modules = join(temporary, 'node_modules');
        for (const [index, archive] of source.packages.entries()) {
          const filename = join(temporary, `${index}.tgz`);
          await download(archive, filename, request, signal);
          await extract(filename, join(modules, archive.name));
          if (signal.aborted) throw error('component_cancelled');
        }
        try { await stage[backend](modules, payload); }
        catch { throw error('component_archive_invalid'); }
      }
      if (!source.binary && await fingerprint(payload) !== source.content) throw error('component_integrity_failed');
      const stamp = { backend, version: source.version, content: source.content ?? source.binary.integrity };
      await writeFile(join(payload, stampName), JSON.stringify(stamp), { flag: 'wx' });
      if (signal.aborted) throw error('component_cancelled');
      const old = await lstat(target).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; return null; });
      const retired = old && join(parent, `.previous-${randomUUID()}`);
      if (old) {
        if (!old.isDirectory() || !samePath(await realpath(target), resolve(target))) throw error('component_storage_failed');
        await rename(target, retired);
      }
      let published = false;
      try {
        await rename(payload, target);
        published = true;
        const result = await installed(backend);
        if (!result) throw error('component_integrity_failed');
        if (retired && samePath(dirname(retired), parent) && samePath((await realpath(retired).catch(() => '')), retired)) {
          await rm(retired, { recursive: true, force: true }).catch(() => {});
        }
        return result;
      }
      catch (cause) {
        if (published) await rename(target, payload).catch(() => {});
        if (retired) await rename(retired, target).catch(() => {});
        throw cause;
      }
    } finally {
      const actual = await realpath(temporary).catch(() => null);
      if (actual && samePath(actual, temporary) && samePath(dirname(actual), parent) && basename(actual).startsWith('.install-')) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return {
    supported, installed,
    status: () => Object.entries(catalog).map(([backend, { version }]) => ({ backend, version })),
    install(backend, signal) {
      if (!pending.has(backend)) {
        const promise = provision(backend, signal).finally(() => pending.delete(backend));
        pending.set(backend, promise);
      }
      return pending.get(backend);
    },
  };
}
