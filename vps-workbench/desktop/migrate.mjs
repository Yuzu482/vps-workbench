import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const portableEntry = /^(?:default-target\.json|ssh-relay\.json|ssh-relay-required|[a-f0-9]{64}|claim-[a-f0-9-]{36})$/i;

async function snapshotEntry(source, destination, previous) {
  const info = await lstat(source);
  if (info.isDirectory()) {
    const children = await readdir(source);
    await mkdir(destination, { mode: 0o700 });
    for (const child of children) await snapshotEntry(join(source, child), join(destination, child), previous);
    previous.push({ source, mtime: info.mtimeMs, size: info.size });
  } else if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    previous.push({ source, mtime: info.mtimeMs, size: info.size });
  } else {
    throw new Error('unsupported_migration_entry');
  }
}

export async function importWorkbenchSnapshot(source, destination) {
  const sourcePath = await realpath(source);
  const destinationPath = await realpath(destination);
  const within = (base, child) => {
    const relation = relative(base, child);
    return !isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep);
  };
  if (within(sourcePath, destinationPath) || within(destinationPath, sourcePath)) throw new Error('overlapping_workbench_data');
  if ((await readdir(destinationPath)).length) throw new Error('workbench_data_exists');
  const sourceInfo = await lstat(sourcePath);
  const list = async () => (await readdir(sourcePath)).filter((name) => portableEntry.test(name)).sort();
  const entries = await list();
  if (!entries.length) throw new Error('workbench_snapshot_not_found');
  const temporary = await mkdtemp(join(dirname(destinationPath), '.import-vps-workbench-'));
  let installed = false;
  try {
    const records = [];
    for (const entry of entries) {
      await snapshotEntry(join(sourcePath, entry), join(temporary, entry), records);
    }
    const names = new Set(entries.map((entry) => entry.toLowerCase()));
    if (names.has('ssh-relay.json') && !names.has('ssh-relay-required')) {
      await writeFile(join(temporary, 'ssh-relay-required'), '', { flag: 'wx', mode: 0o600 });
    }
    records.push({ source: sourcePath, mtime: sourceInfo.mtimeMs, size: sourceInfo.size });
    for (const record of records) {
      const actual = await lstat(record.source);
      if (actual.mtimeMs !== record.mtime || actual.size !== record.size) throw new Error('source_workbench_changed');
    }
    if (JSON.stringify(await list()) !== JSON.stringify(entries)) throw new Error('source_workbench_changed');
    await rmdir(destinationPath);
    try {
      await rename(temporary, destinationPath);
    } catch (error) {
      await mkdir(destinationPath, { recursive: true });
      throw error;
    }
    installed = true;
    return entries.length;
  } finally {
    if (!installed && dirname(temporary) === dirname(destinationPath)) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
