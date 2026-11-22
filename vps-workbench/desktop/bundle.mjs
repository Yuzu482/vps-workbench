import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browserBuildOptions, writeWebAssets } from './web-assets.mjs';
import { stageCodex } from './stage-codex.mjs';
import { stageClaude } from './stage-claude.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const dependencies = resolve(directory, '../node_modules');
const resources = resolve(process.argv[2]);
const onDemand = process.argv.includes('--on-demand-runtimes');
const desktop = join(resources, 'desktop');
await mkdir(join(resources, 'client'), { recursive: true });
await mkdir(desktop, { recursive: true });
await Promise.all([
  ...(!onDemand ? [stageCodex(dependencies, resources), stageClaude(dependencies, resources)] : []),
  writeWebAssets(join(desktop, 'web')),
  build({ ...browserBuildOptions, entryPoints: [join(dependencies, '@novnc/novnc/core/rfb.js')],
    outfile: join(resources, 'client', 'account-player.mjs') }),
  build({
    entryPoints: [join(directory, 'server.mjs')], bundle: true, charset: 'utf8', platform: 'node', format: 'esm',
    nodePaths: [dependencies], external: ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk'], legalComments: 'eof', outfile: join(desktop, 'server.mjs'),
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  }),
]);
