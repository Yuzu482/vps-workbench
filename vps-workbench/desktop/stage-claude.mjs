import { copyFile, cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const version = '0.3.296';
const sdkName = 'claude-agent-sdk';
const platformName = 'claude-agent-sdk-win32-x64';

export async function stageClaude(dependencies, appDirectory) {
  const source = join(dependencies, '@anthropic-ai');
  const sdk = join(source, sdkName);
  const platform = join(source, platformName);
  const [sdkPackage, cliPackage] = await Promise.all([sdk, platform].map(async (path) =>
    JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))));
  if (sdkPackage.name !== '@anthropic-ai/' + sdkName || cliPackage.name !== '@anthropic-ai/' + platformName ||
      sdkPackage.version !== version || cliPackage.version !== version ||
      sdkPackage.optionalDependencies[cliPackage.name] !== version || !(await stat(join(platform, 'claude.exe'))).isFile()) {
    throw new Error('Unexpected Claude Agent SDK or Windows runtime; install the locked dependencies with npm ci');
  }
  const vendor = join(appDirectory, 'helper', 'local-claude');
  await mkdir(vendor, { recursive: true });
  await Promise.all([
    cp(sdk, join(appDirectory, 'node_modules', '@anthropic-ai', sdkName), { recursive: true }),
    copyFile(join(platform, 'claude.exe'), join(vendor, 'claude.exe')),
    copyFile(join(platform, 'LICENSE.md'), join(vendor, 'LICENSE.md')),
    copyFile(join(platform, 'package.json'), join(vendor, 'npm-package.json')),
  ]);
}
