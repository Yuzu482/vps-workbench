import { copyFile, cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const version = '0.166.0';
const target = 'x86_64-pc-windows-msvc';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function stageCodex(dependencies, appDirectory) {
  const sdk = join(dependencies, '@openai', 'codex-sdk');
  const platform = join(dependencies, '@openai', 'codex-win32-x64');
  const vendor = join(platform, 'vendor', target);
  const [sdkPackage, cliPackage, layout] = await Promise.all([
    readJson(join(sdk, 'package.json')),
    readJson(join(platform, 'package.json')),
    readJson(join(vendor, 'codex-package.json')),
  ]);
  if (sdkPackage.name !== '@openai/codex-sdk' || sdkPackage.version !== version ||
      sdkPackage.dependencies?.['@openai/codex'] !== version || sdkPackage.license !== 'Apache-2.0' ||
      cliPackage.name !== '@openai/codex' || cliPackage.version !== version + '-win32-x64' ||
      cliPackage.license !== 'Apache-2.0' || layout.layoutVersion !== 1 || layout.version !== version ||
      layout.target !== target || layout.entrypoint !== 'bin/codex.exe') {
    throw new Error('Unexpected Codex SDK or Windows runtime; install the locked dependencies with npm ci');
  }
  const sdkDestination = join(appDirectory, 'node_modules', '@openai', 'codex-sdk');
  const cliDestination = join(appDirectory, 'helper', 'local-codex');
  await Promise.all([mkdir(sdkDestination, { recursive: true }), mkdir(cliDestination, { recursive: true })]);
  await Promise.all([
    cp(join(sdk, 'dist'), join(sdkDestination, 'dist'), { recursive: true }),
    copyFile(join(sdk, 'package.json'), join(sdkDestination, 'package.json')),
    copyFile(join(sdk, 'LICENSE'), join(sdkDestination, 'LICENSE')),
    cp(vendor, cliDestination, { recursive: true }),
    copyFile(join(platform, 'package.json'), join(cliDestination, 'npm-package.json')),
    // Both upstream packages use Apache-2.0. Preserve the voice notices in the vendor tree.
    copyFile(join(sdk, 'LICENSE'), join(cliDestination, 'LICENSE')),
  ]);
  for (const file of [
    'bin/codex.exe', 'bin/codex-code-mode-host.exe', 'codex-path/rg.exe',
    'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe',
  ]) {
    if (!(await stat(join(cliDestination, file))).isFile()) throw new Error('Missing Codex runtime file ' + file);
  }
}
