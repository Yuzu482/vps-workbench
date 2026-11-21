import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = dirname(fileURLToPath(import.meta.url));
const client = resolve(desktop, '../../remote-workbench/vps-chat');
const assets = resolve(desktop, '../assets');

export const webSourceDirectories = [desktop, assets, resolve(desktop, '../terminal'),
  resolve(desktop, '../resource-library'), resolve(desktop, '../extensions'), resolve(desktop, '../workflow-engine'),
  resolve(desktop, '../workflow-panel'), resolve(desktop, '../agent-presets'), join(client, 'client'), join(client, 'design-export')];

export const browserBuildOptions = {
  bundle: true, minify: true, charset: 'utf8', platform: 'browser', format: 'esm',
  legalComments: 'eof', nodePaths: [resolve(desktop, '../node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
};

export async function buildWebAssets() {
  const [built, html, css, icon] = await Promise.all([
    build({ ...browserBuildOptions, write: false, outdir: join(desktop, 'web'),
      entryPoints: { renderer: join(desktop, 'renderer.mjs'), 'markdown-worker': join(desktop, 'markdown-worker.mjs') },
      loader: { '.png': 'dataurl' } }),
    readFile(join(desktop, 'index.html')),
    readFile(join(desktop, 'workbench.css')),
    readFile(join(assets, 'workbench-icon-64.png')),
  ]);

  const files = new Map([['index.html', html], ['workbench.css', css], ['app-icon.png', icon]]);
  for (const file of built.outputFiles) files.set(basename(file.path), file.contents);
  const hashes = Object.fromEntries([...files.keys()].sort().map((name) =>
    [name, createHash('sha256').update(files.get(name)).digest('hex')]));
  const revision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  return { files, manifest: { revision, hashes } };
}

export async function writeWebAssets(webRoot) {
  const { files, manifest } = await buildWebAssets();
  await mkdir(webRoot, { recursive: true });
  await Promise.all([...files].map(([name, content]) => writeFile(join(webRoot, name), content)));
  await writeFile(join(webRoot, 'revision.json'), JSON.stringify(manifest, null, 2) + '\n');
}
