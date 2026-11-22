import lock from '../package-lock.json' with { type: 'json' };

function npmPackage(name) {
  const { version, resolved: url, integrity } = lock.packages[`node_modules/${name}`];
  if (new URL(url).origin !== 'https://registry.npmjs.org' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw new Error('Invalid component package pin');
  }
  return { name, version, url, integrity: integrity.slice(7) };
}

const codex = npmPackage('@openai/codex-sdk');
const claude = npmPackage('@anthropic-ai/claude-agent-sdk');
const agy = {
  version: '1.5.14',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/windows-x64/cli_windows_x64.exe',
  integrity: Buffer.from('785548b23242ec9112759bb4b525d94a3d4d2e9868e5cedb9ea34e5ce01dbb00abf5de66c41d8f4903e8a4379445f685483f999ece91867bfbd9d4812760d835', 'hex').toString('base64'),
  bytes: 238615704,
};

export const componentCatalog = Object.freeze({
  // SHA-256 of the staged files from the locked Windows archives, independent of the install directory.
  codex: { version: codex.version, packages: [codex, npmPackage('@openai/codex-win32-x64')],
    content: '77de5d0fa600d9ea7975003159b4d6ba9765e86a048451bb58a3ab3df9daed45' },
  'claude-sdk': { version: claude.version, packages: [claude, npmPackage('@anthropic-ai/claude-agent-sdk-win32-x64')],
    content: '1c7730ed1114246e480149f347921feca7b67c639b1c378bbeda28911c79ba15' },
  antigravity: { version: agy.version, binary: agy },
});
