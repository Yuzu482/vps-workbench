import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exactFields, maxWorkflowAttachmentBytes, maxWorkflowAttachments, validWorkflowFileName,
} from '../workflow-engine/state.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const maxEncodedBytes = 4 * Math.ceil(maxWorkflowAttachmentBytes / 3);
const missing = () => new Error('阶段附件已缺失或变更，请重新选择本地文件。');

export function decodeWorkflowAttachments(files) {
  if (!Array.isArray(files) || !files.length || files.length > maxWorkflowAttachments) {
    throw new Error('一次最多选择 8 个阶段附件。');
  }
  const names = new Set();
  let size = 0;
  return Array.from(files, (file) => {
    if (!exactFields(file, 'name', 'data') || !validWorkflowFileName(file.name) || names.has(file.name) ||
        typeof file.data !== 'string' || file.data.length > maxEncodedBytes) throw new Error('阶段附件格式无效。');
    const bytes = Buffer.from(file.data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== file.data) throw new Error('阶段附件内容无效。');
    size += bytes.length;
    if (size > maxWorkflowAttachmentBytes) throw new Error('每阶段本地附件总计最多 512 KiB。');
    names.add(file.name);
    return { name: file.name, digest: sha256(bytes), size: bytes.length, bytes };
  });
}

export function openWorkflowAttachmentStore(root) {
  const directory = join(root, 'workflow-attachments');
  async function verifyDirectory() {
    const info = await lstat(directory);
    if (!info.isDirectory() || await realpath(directory) !== directory) throw missing();
  }

  async function read({ digest, size }) {
    if (typeof digest !== 'string' || !digestPattern.test(digest) || !Number.isSafeInteger(size) ||
        size <= 0 || size > maxWorkflowAttachmentBytes) throw missing();
    await verifyDirectory();
    const path = join(directory, digest);
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size !== size) throw missing();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== size || opened.dev !== info.dev ||
          opened.ino !== info.ino) throw missing();
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const content = bytes.subarray(0, length);
      if (length !== size || sha256(content) !== digest) throw missing();
      return content;
    } finally {
      await file.close();
    }
  }

  return {
    async save(files) {
      const items = decodeWorkflowAttachments(files);
      await mkdir(directory, { mode: 0o700, recursive: true });
      await verifyDirectory();
      const refs = [];
      for (const { bytes, ...ref } of items) {
        try { await read(ref); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const target = join(directory, ref.digest);
          const temporary = target + '.' + randomUUID() + '.tmp';
          try {
            await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            await rename(temporary, target);
          } finally { await rm(temporary, { force: true }); }
          await read(ref);
        }
        refs.push(ref);
      }
      return refs;
    },
    async materialize(refs) {
      return Promise.all(refs.map(async (ref) => ({ name: ref.name, data: (await read(ref)).toString('base64') })));
    },
  };
}
