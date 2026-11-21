'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const browserTestRoot = resolve(__dirname, '../../../dsh-terminal-workbench/client/browser-test');
const { build } = require('esbuild');
const { chromium } = require(join(browserTestRoot, 'node_modules/playwright-core'));

const exampleCode = [
  'const label = "<button>按原文复制</button>";',
  '  console.log(label);',
  `// ${'保持滚动边界'.repeat(32)}`,
].join('\n');
const markdownReply = [
  '## 项目包含三个主要模块。', '',
  '**客户端**显示 *强调*、`status` 和 ~~旧结果~~。', '',
  '1. 客户端负责会话界面。',
  '   - 支持查找原会话。',
  '2. 本机桥保存回执。',
  '3. VPS 执行模型请求。', '',
  '- [x] 已核对会话。', '',
  '这些符号应显示为文本 &lt;示例&gt; &amp; &#65;。', '',
  '> 请核对同一轮的状态。', '',
  '| 检查 | 结果 |', '| --- | --- |', '| 出口 | 一致 |', '',
  '[文档](https://docs.example.invalid/workbench)',
  '[无效协议](unsafe:fixture)',
  '![外部图片](https://preview.example.invalid/thumbnail.png)',
  '![引用图片][photo]', '',
  '[photo]: https://preview.example.invalid/reference.png', '',
  '<mark data-markdown-fixture="raw-html">原始标签</mark>', '',
  '```javascript', exampleCode, '```',
].join('\n');

function designReply(version, closed) {
  const shades = version === 1 ? '#214738' : '#213b5c';
  const heading = version === 1 ? '晚风书店' : '晚风夜读';
  const fence = String.fromCharCode(96).repeat(3);
  return [
    '已准备好原型。', '', fence + 'html',
    '<!doctype html><html lang="zh-CN" style="background-image:url(https://preview.invalid/root.png)"><head>',
    '<meta http-equiv="refresh" content="1; url=https://preview.invalid/refresh">',
    '<base href="https://preview.invalid/base/">',
    '<link rel="stylesheet" href="https://preview.invalid/style.css">',
    '<title>书店首页</title>',
    '<style>@import url(https://preview.invalid/extra.css);body{background-image:url(https://preview.invalid/background.png)}</style>',
    '<style>body { margin:0; padding:clamp(20px,6vw,72px); background:#f7f1e5;color:#25322f;font-family:system-ui,sans-serif; }' +
      'main{max-width:680px;margin:auto;padding:clamp(20px,5vw,64px);background:#fcfaf5;border:1px solid #ded8c9;border-radius:24px}' +
      'h1 { font-family:Georgia,serif;font-size:clamp(32px,6vw,72px);color:' + shades + '; }' +
      'summary{cursor:pointer;color:' + shades + ';font-weight:600}</style></head><body>',
    '<main><h1 id="hero-title">' + heading + '</h1><p>特别选集</p>',
    '<button data-dsh-go="2">查看活动</button>',
    '<details><summary>营业信息</summary><p>每晚十点闭店</p></details>',
    '<a href="https://preview.invalid/link">站外链接文字</a>',
    '<img src="https://preview.invalid/image.png" alt="外部图片">',
    '<iframe src="https://preview.invalid/frame"></iframe>',
    '<script type="text/plain" id="fixture-script">fixture</script>',
    '<form action="https://preview.invalid/submit"><button onclick="return false">预约</button></form>',
    '</main></body></html>',
    ...(closed ? [fence, '', fence + 'html',
      '<!doctype html><title>活动详情</title><main><h1>周五读书会</h1><button data-dsh-go="1">回到首页</button></main>',
      fence] : []),
  ].join('\n');
}

test('VPS chat renders session history and recovers an uncertain send without replay', { timeout: 105000 }, async t => {
  const { createHost, prefix } = await import(pathToFileURL(join(__dirname, 'index.js')));
  const previewDirectory = process.env.DSH_VPS_UX_PREVIEW_DIRECTORY;
  const composerPreview = process.env.DSH_VPS_COMPOSER_PREVIEW_DIRECTORY;
  const projectsPreview = process.env.DSH_VPS_PROJECTS_PREVIEW_DIRECTORY;
  const toolsPreview = process.env.DSH_VPS_TOOLS_PREVIEW_DIRECTORY;
  const settingsPreview = process.env.DSH_VPS_SETTINGS_PREVIEW_DIRECTORY;
  const accountsPreview = process.env.DSH_VPS_ACCOUNTS_PREVIEW_DIRECTORY;
  const previewSource = process.env.DSH_VPS_UX_PREVIEW_SOURCE;
  const showcase = previewDirectory && previewSource ? (await readFile(previewSource, 'utf8')).trim() : '';
  const calls = [];
  const saved = new Map();
  const streams = new Map();
  const steerFixtures = new Map();
  let completeDesign = false;
  let modelReads = 0;
  let targetId = 'c'.repeat(64);
  let preset = null;
  let failSettingsModels = false;
  const settingsTargets = { claude: '4'.repeat(64), 'claude-sdk': '6'.repeat(64), antigravity: '8'.repeat(64) };
  const bridge = {
    request(packet) {
      calls.push(packet);
      if (packet.op === 'preset') return { ok: true, preset };
      const settingsFixture = packet.settings?.host === 'settings-fixture.invalid';
      const distinctTargets = settingsFixture || packet.settings?.host === 'accounts-fixture.invalid';
      const route = distinctTargets ? settingsTargets[packet.settings.provider] ?? targetId : targetId;
      if (packet.op === 'list') return {
        ok: true, targetId: route, sessions: [...saved.values()].map(({ id, title, mode }) => ({ id, title, mode })),
      };
      if (packet.targetId !== route || (settingsFixture && failSettingsModels && packet.op === 'models')) {
        return { ok: false, code: 'target_changed', message: '主机指纹已变化，请重新核对。' };
      }
      if (packet.op === 'models') {
        if (['claude', 'claude-sdk'].includes(packet.settings.provider)) return { ok: true, models: [
          { id: 'sonnet', displayName: 'Claude Sonnet', isDefault: false, efforts: [], defaultEffort: null },
          { id: 'opus', displayName: 'Claude Opus', isDefault: false, efforts: [], defaultEffort: null },
        ] };
        if (++modelReads === 1) return { ok: false, code: 'models_unavailable', message: '暂时无法读取 VPS 模型目录。' };
        return { ok: true, models: [
          { id: 'fixture-fast', displayName: '测试快速模型', isDefault: true, efforts: ['low', 'medium'], defaultEffort: 'low' },
          { id: 'fixture-visual', displayName: '测试视觉模型', isDefault: false, efforts: ['medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `fixture-extra-${index + 3}`, displayName: `测试候选 ${index + 3}`, isDefault: false, efforts: [], defaultEffort: null,
          })),
        ] };
      }
      const { sessionId: id } = packet;
      let session = saved.get(id) ?? { id, title: '新对话', turns: [], canSend: true };
      if (packet.op === 'send') {
        if (settingsFixture) {
          session = { ...session, turns: [...session.turns, {
            id: packet.turnId, prompt: packet.prompt, state: 'complete', reply: '设置测试已完成。', activity: [],
            model: packet.model ?? null, effort: packet.effort ?? null,
          }] };
          saved.set(id, session);
          return { ok: true, session };
        }
        if (packet.mode === 'design') {
          const turns = [...session.turns, {
            id: packet.turnId, prompt: packet.prompt, state: 'pending', reply: '', activity: [], streaming: true, canStop: true,
            ...(packet.model ? { model: packet.model, effort: packet.effort } : {}),
          }];
          session = { id, title: session.turns.length ? session.title : packet.prompt, turns, canSend: false, mode: 'design' };
          saved.set(id, session);
          if (packet.prompt.startsWith('测试生成时补充'))
            steerFixtures.set(id, { complete: false, drop: packet.prompt.endsWith('断线'), reconcile: true });
          return { ok: true, session };
        }
        if (packet.prompt.startsWith('测试流式')) {
          session = { id, title: packet.prompt, canSend: false, turns: [
            { id: packet.turnId, prompt: packet.prompt, state: 'pending', reply: '', activity: [], streaming: true, canStop: true },
          ] };
          saved.set(id, session);
          streams.set(id, { reads: 0, stop: false, drop: packet.prompt.endsWith('断线') });
          return { ok: true, session };
        }
        session = {
          id, title: packet.prompt, canSend: false,
          turns: [{ id: packet.turnId, prompt: packet.prompt, state: 'unknown', reply: '', activity: [] }],
        };
        saved.set(id, session);
        return { ok: false, code: 'unknown', message: '暂时无法确认结果。' };
      }
      const steering = steerFixtures.get(id);
      if (packet.op === 'steer') {
        const turn = session.turns.at(-1);
        assert.ok(steering && turn.id === packet.turnId && turn.canSteer && !session.canSend);
        assert.equal(packet.designContext, undefined);
        assert.equal(packet.model, undefined);
        assert.equal(packet.effort, undefined);
        turn.steering ??= [];
        assert.ok(!turn.steering.some(note => note.id === packet.steerId));
        turn.steering.push({ id: packet.steerId, prompt: packet.prompt, state: 'queued' });
        if (steering.drop) {
          steering.reconcile = false;
          return { ok: false, code: 'unknown', message: '提交结果待确认。' };
        }
        return { ok: true, session };
      }
      if (steering && packet.op === 'get') steering.reconcile = true;
      const stream = streams.get(id);
      if (stream && packet.op === 'stop') {
        assert.equal(packet.turnId, session.turns.at(-1).id);
        assert.equal(packet.prompt, undefined);
        assert.equal(stream.stop, false);
        stream.stop = true;
        stream.reads = 0;
        return stream.drop ? { ok: false, code: 'stop_unknown', message: '停止请求结果待确认。' }
          : { ok: true, outcome: 'requested' };
      }
      if (packet.op === 'refresh') {
        const turn = session.turns.at(-1);
        if (session.mode === 'design') {
          if (steering) {
            turn.state = steering.complete ? 'complete' : 'running';
            turn.canSteer = !steering.complete;
            turn.canStop = !steering.complete;
            turn.reply = steering.complete ? designReply(2, true) : '';
            session.canSend = steering.complete;
            if (!steering.reconcile) {
              return { ok: true, session: { ...session, turns: [...session.turns.slice(0, -1), { ...turn, steering: [] }] } };
            }
            turn.steering?.forEach(note => { note.state = 'delivered'; });
            return { ok: true, session };
          }
          turn.state = completeDesign ? 'complete' : 'running';
          turn.reply = designReply(session.turns.length, completeDesign && !turn.prompt.endsWith('未闭合'));
          turn.canStop = !completeDesign;
          session.canSend = completeDesign;
          if (completeDesign && turn.model) turn.contextUsage = { usedTokens: 12345, contextWindow: 128000 };
          return { ok: true, session };
        }
        if (stream) {
          stream.reads++;
          if (stream.stop) {
            turn.state = stream.reads < 2 ? 'stopping' : 'stopped';
            turn.canStop = false;
            session.canSend = turn.state === 'stopped';
          } else {
            turn.state = 'running';
            turn.reply = '增量第一段。' + (stream.reads > 1 ? '\n\n增量第二段。' : '');
          }
          return { ok: true, session };
        }
        if (turn.state === 'unknown') {
          turn.state = 'running';
          turn.reply = '正在读取项目结构。\n\n```sh\nprintf partial';
          turn.activity = [{ title: '只读工具', text: 'Glob' }];
        } else {
          turn.state = 'complete';
          turn.reply = markdownReply;
          session.canSend = true;
        }
      }
      return { ok: true, session };
    },
  };
  const react = (await build({
    stdin: { resolveDir: browserTestRoot, contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      async function writeClipboard(text) {
        window.fixtureCopiedSource = text;
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
      }
      // The Desktop provides CodeBlock and writeClipboard as platform modules.
      // Keep the fixture on their public props without loading Desktop itself.
      function CodeBlock({code, lang, className, copyLabel, copiedLabel}) {
        const [copied, setCopied] = React.useState(false);
        return React.createElement('div', {className, 'data-language': lang},
          React.createElement('button', {type: 'button', onClick: async () => setCopied(await writeClipboard(code))},
            copied ? copiedLabel : copyLabel),
          React.createElement('pre', {style: {overflow: 'auto'}}, React.createElement('code', null, code)));
      }
      let workspaceSnapshot = { items: [], state: 'loading', phase: 'pending' };
      const listeners = new Set();
      const workspaces = { list: {
        getSnapshot() { return workspaceSnapshot; },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } };
      window.fixtureSetWorkspaces = (items) => {
        workspaceSnapshot = { items, state: 'idle', phase: 'ready' };
        for (const listener of listeners) listener();
      };
      let terminalView, terminalListener;
      window.__ModuleLoader__ = { load(spec) {
        if (!['dsh-vps-chat-workbench', 'dsh-terminal-workbench'].includes(spec.id)) throw Error('Unexpected module');
        const plugin = spec.factory(name => {
          if (name === 'react') return React;
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return { CodeBlock, writeClipboard };
          throw Error('Unexpected dependency');
        });
        plugin.apply({workspaces, effect(start) { start(); },
          inject(keys, bind) {
            if (keys[0] !== 'dshClaudeSubscriptionView') throw Error('Unexpected optional service');
            terminalListener = bind;
            if (terminalView) bind({dshClaudeSubscriptionView:terminalView});
          },
          reflect:{provide(name, value) {
            if (name !== 'dshClaudeSubscriptionView') throw Error('Unexpected provider');
            terminalView = value;
            terminalListener?.({dshClaudeSubscriptionView:terminalView});
          }},
          desktopWorkbenches: { register(meta, Component) {
          if (!meta.customFrame) throw Error('Unexpected workbench');
          const remote = spec.id === 'dsh-terminal-workbench';
          const root = createRoot(document.getElementById(remote ? 'native-root' : 'root'));
          if (remote) window.fixtureShowNative = () => {
            document.getElementById('native-root').hidden = false;
            root.render(React.createElement(Component, { active:true }));
          };
          root.render(React.createElement(Component, { active:!remote }));
          return () => root.unmount();
        } }});
      } };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife',
  })).outputFiles[0].text;
  const native = await readFile(join(browserTestRoot, '../client.js'));
  const nativeCalls = [];
  const nativeLaunches = [];
  const nativeId = '22222222-2222-4222-8222-222222222222';
  const nativeEvents = [];
  let rejectNextNativeInput = false;
  let holdSubscriptionBootstrap = false;
  let releaseSubscriptionBootstrap;
  const packagedClient = process.env.DSH_VPS_CHAT_CLIENT_BUNDLE;
  const client = packagedClient ? await readFile(resolve(packagedClient), 'utf8') : (await build({
    entryPoints: [join(__dirname, '../client/client.js')],
    bundle: true, write: false, platform: 'browser', format: 'iife', charset: 'utf8', legalComments: 'inline',
    loader: { '.png': 'dataurl' },
  })).outputFiles[0].text;
  let host;
  const server = http.createServer((req, res) => {
    if (req.url === prefix + 'token') return host.token(req, res);
    if (req.url === prefix + 'rpc') return host.rpc(req, res);
    if (req.url === '/dsh-terminal-workbench/api/bootstrap') {
      const respond = () => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({token:'synthetic-native-token'}));
      };
      if (holdSubscriptionBootstrap) releaseSubscriptionBootstrap = respond;
      else respond();
      return;
    }
    if (req.url === '/dsh-terminal-workbench/api/rpc') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        nativeCalls.push(packet);
        if (packet.op === 'native-subscription-start') {
          if (packet.targetId !== targetId) {
            res.writeHead(409, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ok:false,code:'subscription_preflight_rejected'}));
          }
          nativeLaunches.push(packet);
        }
        if (packet.op === 'native-input' && rejectNextNativeInput) {
          rejectNextNativeInput = false;
          res.writeHead(502, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false}));
        }
        const events = packet.op === 'native-poll' ? nativeEvents.slice(packet.after) : [];
        const result = {state:'ready', sessionId:nativeId, lastSequence:nativeEvents.length, events, gap:false, acknowledged:0};
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,result}));
      });
      return;
    }
    if (req.url === '/react.js' || req.url === '/client.js' || req.url === '/native.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(req.url === '/react.js' ? react : req.url === '/native.js' ? native : client);
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><div id="native-root" hidden></div><script src="/react.js"></script><script src="/client.js"></script><script src="/native.js"></script></html>');
    }
    res.writeHead(404); res.end();
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  host = createHost({ port, bridge });
  t.after(() => { host.dispose(); return new Promise(close => server.close(close)); });
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1272, height: 822 }, colorScheme: 'light' });
    await page.addInitScript(() => {
      let text = '';
      Object.defineProperty(navigator, 'clipboard', { value: {
        readText: async () => text,
        writeText: async value => { text = value; },
      } });
    });
    const external = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto(origin);
    const send = page.getByRole('button', { name: '发送', exact: true });
    const chooser = page.getByRole('button', { name: '切换 VPS 执行端', exact: true });
    const palette = page.getByRole('listbox', { name: '已配置的 VPS 执行端', exact: true });
    const workbench = page.locator('[data-vps-chat]');
    const expectToolIcon = async (target, name, width) => {
      const icon = target.locator(`.vc-menu-icon[data-icon="${name}"]`);
      await icon.waitFor();
      assert.equal(await icon.getAttribute('aria-hidden'), 'true');
      if (width) {
        const image = await icon.locator('img').evaluate(async (node) => {
          await node.decode();
          return { width: node.naturalWidth, height: node.naturalHeight, local: node.src.startsWith('data:image/png;base64,') };
        });
        assert.deepEqual(image, { width, height: width, local: true });
      }
      if (name === 'claude-code') {
        const marker = await icon.evaluate(node => getComputedStyle(node, '::after').content);
        assert.equal(marker, '"›_"');
      }
    };
    const setDesktopDark = (dark) => page.evaluate((enabled) =>
      document.body.toggleAttribute('data-ds-dark-theme', enabled), dark);
    const expectToolTheme = async (tool, scheme, accent) => {
      const theme = await workbench.evaluate((root) => {
        const style = getComputedStyle(root);
        const primary = getComputedStyle(root.querySelector('.vc-new'));
        const luminance = (rgb) => rgb.match(/\d+/g).slice(0, 3).map((channel) => {
          const value = Number(channel) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
        const levels = [luminance(primary.color), luminance(primary.backgroundColor)];
        return {
          tool: root.dataset.toolTheme, scheme: style.colorScheme, canvas: style.backgroundColor,
          accent: style.getPropertyValue('--vc-accent').trim(),
          primary: primary.backgroundColor, contrast: (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05),
        };
      });
      assert.equal(theme.tool, tool);
      assert.equal(theme.scheme, scheme);
      assert.equal(theme.accent, accent);
      assert.ok(theme.contrast >= 4.5, JSON.stringify(theme));
      return theme;
    };
    const toolNames = () => palette.getByRole('option').evaluateAll(rows => rows.map(row => row.ariaLabel));
    const openTools = async () => {
      if (await chooser.getAttribute('aria-expanded') !== 'true') await chooser.click();
      await palette.waitFor();
    };
    const chooseTool = async (label) => {
      await openTools();
      await palette.getByRole('option', { name: label, exact: true }).click();
      const selected = palette.locator('[aria-selected=true]');
      await selected.and(palette.getByRole('option', { name: label, exact: true })).waitFor();
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
    };
    await page.getByText('Codex · VPS 待配置', { exact: true }).waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await chooser.count(), 0);
    assert.deepEqual(calls, [{ op: 'preset' }]);
    await page.getByRole('button', { name: '配置 VPS', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'VPS 设置', exact: true });
    const use = settings.getByRole('button', { name: '使用此 VPS' });
    assert.equal(await use.isDisabled(), true);
    const saveTools = settings.getByRole('button', {name:'保存执行端', exact:true});
    const toolSetting = (name) => settings.getByRole('checkbox', {name, exact:true});
    const openToolSettings = () => page.getByRole('button', {name:'VPS 设置', exact:true}).click();
    assert.equal(await settings.getByRole('button', {name:'执行端',exact:true}).isDisabled(),true);
    const fields = {
      'VPS 主机': 'fixture.invalid', 'SSH 用户名': 'fixture',
      'SSH 私钥文件路径': 'C:/fixture/key', 'known_hosts 文件路径': 'C:/fixture/known_hosts',
      '远端项目目录': '/workspace/fixture', '预期 VPS 出口 IPv4': '192.0.2.18',
    };
    for (const [label, value] of Object.entries(fields)) await settings.getByLabel(label, { exact: true }).fill(value);
    await settings.getByRole('checkbox').check();
    await use.click();
    await saveTools.waitFor();
    assert.equal(await chooser.count(),0);
    assert.equal(await toolSetting('Codex').isChecked(),false);
    await settings.getByText(/配置.*API 凭据/).waitFor();
    await toolSetting('Codex').check();
    assert.equal(await chooser.count(),0);
    await saveTools.click();
    await settings.waitFor({ state: 'hidden' });
    assert.equal(calls.find(item => item.op === 'list')?.settings.provider, 'codex');
    assert.ok(calls.every(item => ['preset', 'list', 'get'].includes(item.op)));
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    const initialHeight = (await composer.boundingBox()).height;
    await composer.fill(Array.from({ length: 20 }, (_, index) => `草稿第 ${index + 1} 行`).join('\n'));
    const draftSize = await composer.evaluate((element) => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
    assert.ok(draftSize.height > initialHeight && draftSize.contentHeight > draftSize.height, JSON.stringify(draftSize));
    await composer.fill('');
    assert.equal((await composer.boundingBox()).height, initialHeight);
    await composer.fill('请概括项目结构');
    await composer.dispatchEvent('compositionstart');
    await composer.press('Enter');
    assert.equal(calls.filter(item => item.op === 'send').length, 0);
    await composer.dispatchEvent('compositionend');
    await composer.fill('请概括项目结构');
    await send.click();
    await page.getByText('发送结果待确认。请先查询这轮任务。').waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('button', { name: '查询原任务', exact: true }).click();
    const messages = page.getByRole('region', { name: '对话消息', exact: true });
    await messages.getByText('正在读取项目结构。', { exact: true }).waitFor();
    await messages.locator('pre code').getByText('printf partial', { exact: true }).waitFor();
    await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
    const markdown = messages.locator('.vc-markdown');
    assert.equal(await markdown.locator('strong').textContent(), '客户端');
    assert.equal(await markdown.locator('em').textContent(), '强调');
    assert.equal(await markdown.locator('del').textContent(), '旧结果');
    assert.equal(await markdown.locator('ol ul li').textContent(), '支持查找原会话。');
    const completedTask = markdown.getByRole('checkbox');
    assert.equal(await completedTask.isChecked(), true);
    assert.equal(await completedTask.isDisabled(), true);
    assert.match(await markdown.textContent(), /<示例> & A/);
    assert.equal(await markdown.locator('blockquote').innerText(), '请核对同一轮的状态。');
    assert.equal(await markdown.getByRole('cell', { name: '一致' }).count(), 1);
    assert.equal(await markdown.getByRole('link', { name: '文档' }).getAttribute('href'), 'https://docs.example.invalid/workbench');
    assert.equal(await markdown.getByRole('link', { name: '无效协议' }).count(), 0);
    assert.equal(await markdown.locator('img, [data-markdown-fixture]').count(), 0);
    assert.match(await markdown.textContent(), /外部图片/);
    assert.match(await markdown.textContent(), /引用图片/);
    assert.match(await markdown.textContent(), /原始标签/);
    assert.equal(await markdown.locator('pre code').textContent(), exampleCode);
    await markdown.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.waitForFunction(expected => navigator.clipboard.readText().then(text => text.replace(/\r\n/g, '\n') === expected), exampleCode);
    assert.equal(await page.evaluate(() => window.fixtureCopiedSource), exampleCode);
    await messages.getByRole('button', { name: '复制回复', exact: true }).click();
    await page.waitForFunction(expected => navigator.clipboard.readText().then(text => text.replace(/\r\n/g, '\n') === expected), markdownReply);
    assert.equal(await page.evaluate(() => window.fixtureCopiedSource), markdownReply);
    assert.equal(await messages.locator('.vc-copy-status').textContent(), '已复制');
    const originalWrite = await page.evaluateHandle(() => navigator.clipboard.writeText);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Fixture denied clipboard write', 'NotAllowedError')),
      });
    });
    await messages.getByRole('button', { name: '复制回复', exact: true }).click();
    await messages.locator('.vc-copy-status').getByText('复制失败', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), markdownReply);
    await page.evaluate(write => Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: write,
    }), originalWrite);
    await originalWrite.dispose();
    await messages.getByText('查看运行详情').click();
    await messages.getByText('Glob', { exact: true }).waitFor();
    const sends = calls.filter(item => item.op === 'send');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].prompt, '请概括项目结构');
    assert.equal(sends[0].settings.provider, 'codex');
    await messages.getByText('Codex', { exact: true }).waitFor();
    assert.ok(calls.filter(item => item.op === 'refresh').every(item => item.sessionId === sends[0].sessionId));

    if (process.env.DSH_VPS_CHAT_SCREENSHOT) await page.screenshot({ path: process.env.DSH_VPS_CHAT_SCREENSHOT });
    await composer.fill('这是一条会话草稿');
    await page.getByRole('button', { name: '新对话' }).first().click();
    assert.equal(await composer.inputValue(), '');
    await page.getByRole('button', { name: '请概括项目结构', exact: true }).click();
    await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
    assert.equal(await composer.inputValue(), '这是一条会话草稿');
    for (const width of [1024, 700, 390]) {
      await page.setViewportSize({ width, height: 760 });
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        chat: document.querySelector('.vc-main').getBoundingClientRect().width,
      }));
      assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.chat > 250, JSON.stringify(dimensions));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.equal(calls.filter(item => item.op === 'send').length, 1);

    targetId = 'd'.repeat(64);
    await send.click();
    await settings.waitFor();
    assert.equal(await settings.getByRole('checkbox').isChecked(), false);
    assert.equal(await use.isDisabled(), true);
    assert.ok(await settings.getByText('主机指纹已变化，请重新核对。').isVisible());
    await settings.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await send.isDisabled(), true);

    preset = { name: 'dsh-test-jp', settings: sends[0].settings, targetId,
      sessions: [...saved.values()].map(({ id, title }) => ({ id, title })) };
    const beforeReload = calls.length;
    await page.setViewportSize({ width: 1272, height: 822 });
    await page.reload();
    await page.getByText('dsh-test-jp · 已配置', { exact: true }).waitFor();
    assert.equal(await chooser.getAttribute('data-provider'), 'codex');
    assert.equal(await composer.inputValue(), '');
    assert.equal(await send.isDisabled(), true);
    assert.deepEqual(calls.slice(beforeReload), [{ op: 'preset' }]);
    await page.getByRole('button', { name: '请概括项目结构', exact: true }).click();
    await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
    assert.deepEqual(calls.slice(beforeReload).map(item => item.op), ['preset', 'get']);

    for (const prompt of ['测试流式停止', '测试流式停止断线']) {
      await page.getByRole('button', { name: '新对话' }).first().click();
      await composer.fill(prompt);
      await send.click();
      const stop = page.getByRole('button', { name: '停止生成', exact: true });
      await stop.waitFor();
      await messages.getByText('增量第一段。', { exact: true }).waitFor();
      await messages.getByText('增量第二段。', { exact: true }).waitFor();
      assert.equal(await messages.getByText('已完成', { exact: true }).count(), 0);
      await stop.click();
      if (prompt.endsWith('断线')) {
        await page.getByText('停止请求结果待确认。请查询原任务。', { exact: true }).waitFor();
        await page.getByRole('button', { name: '查询原任务', exact: true }).click();
      } else {
        const stopping = page.getByRole('button', { name: '正在停止', exact: true });
        await stopping.waitFor();
        assert.equal(await stopping.isDisabled(), true);
      }
      await messages.getByText('已停止', { exact: true }).waitFor();
      await messages.getByText('增量第二段。', { exact: true }).waitFor();
      assert.equal(await stop.count(), 0);
      const submitted = calls.filter(item => item.op === 'send' && item.prompt === prompt);
      assert.equal(submitted.length, 1);
      const { sessionId, turnId } = submitted[0];
      assert.deepEqual(calls.filter(item => item.op === 'stop' && item.sessionId === sessionId).map(item => item.turnId), [turnId]);
      await composer.fill('停止后继续测试');
      assert.equal(await send.isDisabled(), false);
    }

    await page.getByRole('button', { name: '新建设计', exact: true }).click();
    const canvas = page.getByRole('region', { name: '设计画布', exact: true });
    await canvas.waitFor();
    const preview = canvas.locator('iframe[title="设计原型预览"]');
    const contents = preview.contentFrame();
    const brief = '设计晚风书店的单页';
    await composer.fill(brief);
    await send.click();
    await messages.getByText('VPS 正在处理', { exact: true }).waitFor();
    assert.equal(await preview.count(), 0, 'An unfinished fence should never enter the canvas.');
    completeDesign = true;
    await contents.getByRole('heading', { name: '晚风书店' }).waitFor();
    const layout = page.getByRole('group', { name: '设计视图', exact: true });
    const chatOnly = layout.getByRole('button', { name: '对话', exact: true });
    const splitView = layout.getByRole('button', { name: '并排', exact: true });
    const canvasOnly = layout.getByRole('button', { name: '画布', exact: true });
    const divider = page.getByRole('separator', { name: '调整对话宽度', exact: true });
    assert.equal(await splitView.getAttribute('aria-pressed'), 'true');
    assert.ok(await composer.isVisible() && await canvas.isVisible());
    const beforeLayout = calls.length;
    const initialWidth = (await messages.boundingBox()).width;
    await divider.press('ArrowRight');
    const afterArrow = (await messages.boundingBox()).width;
    assert.ok(afterArrow > initialWidth, JSON.stringify({ initialWidth, afterArrow }));
    const handle = await divider.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 43, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.ok((await messages.boundingBox()).width < afterArrow, 'Pointer interaction adjusts the same split');
    await composer.fill('切换布局保留这条草稿');
    await canvasOnly.click();
    assert.equal(await composer.isVisible(), false);
    assert.equal(await divider.isVisible(), false);
    await contents.getByRole('heading', { name: '晚风书店' }).waitFor();
    await chatOnly.click();
    assert.equal(await canvas.isVisible(), false);
    assert.equal(await composer.inputValue(), '切换布局保留这条草稿');
    await splitView.click();
    assert.ok(await canvas.isVisible() && await composer.isVisible());
    assert.equal(await composer.inputValue(), '切换布局保留这条草稿');
    await composer.fill('');
    await composer.focus();
    await page.keyboard.press('F6');
    assert.ok(await canvas.evaluate(element => element.contains(document.activeElement)));
    await page.keyboard.press('Shift+F6');
    assert.equal(await composer.evaluate(element => element === document.activeElement), true);
    assert.equal(calls.length, beforeLayout, 'Layout and editing focus do not issue any network RPC');
    assert.equal(await preview.getAttribute('sandbox'), 'allow-same-origin');
    assert.equal(await preview.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await contents.locator('html').getAttribute('style'), null);
    assert.equal(await contents.locator('script, iframe, img, base, link, form, [onclick], meta[http-equiv="refresh"]').count(), 0);
    assert.equal(await contents.locator('a[href]').count(), 0);
    const hours = contents.getByText('每晚十点闭店', { exact: true });
    assert.equal(await hours.isVisible(), false);
    // Input coordinates in the iframe use its unscaled CSS pixels.
    async function previewPoint(element) {
      const center = await element.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, width: innerWidth, height: innerHeight };
      });
      const frameBounds = await preview.boundingBox();
      return {
        x: frameBounds.x + center.x * frameBounds.width / center.width,
        y: frameBounds.y + center.y * frameBounds.height / center.height,
      };
    }
    async function clickInPreview(element) {
      const { x, y } = await previewPoint(element);
      await page.mouse.click(x, y);
    }
    async function dragInPreview(element, deltaX, deltaY) {
      const { x, y } = await previewPoint(element);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + deltaX, y + deltaY, { steps: 5 });
      await page.mouse.up();
    }
    await clickInPreview(contents.getByText('营业信息', { exact: true }));
    assert.equal(await hours.isVisible(), true);
    await clickInPreview(contents.getByRole('button', { name: '查看活动' }));
    await contents.getByRole('heading', { name: '周五读书会' }).waitFor();
    await clickInPreview(contents.getByRole('button', { name: '回到首页' }));
    await contents.getByRole('heading', { name: '晚风书店' }).waitFor();
    await canvas.getByRole('button', { name: '移动', exact: true }).click();
    const mobile = await preview.boundingBox();
    assert.ok(mobile.width <= 400 && mobile.width >= 300, JSON.stringify(mobile));
    await canvas.getByRole('button', { name: '桌面', exact: true }).click();
    assert.ok((await preview.boundingBox()).width > mobile.width);

    const editCanvas = canvas.getByRole('button', { name: '编辑画布', exact: true });
    await editCanvas.click();
    const layerId = await contents.locator('#hero-title').getAttribute('data-dsh-layer');
    await canvas.getByRole('combobox', { name: '图层', exact: true }).selectOption(layerId);
    const layerText = canvas.getByRole('textbox', { name: '图层文字', exact: true });
    await layerText.fill('本地改稿标题');
    await canvas.getByRole('button', { name: '应用文字', exact: true }).click();
    await contents.getByRole('heading', { name: '本地改稿标题' }).waitFor();
    await canvas.getByRole('button', { name: '撤销', exact: true }).click();
    await contents.getByRole('heading', { name: '晚风书店' }).waitFor();
    await canvas.getByRole('button', { name: '重做', exact: true }).click();
    await contents.getByRole('heading', { name: '本地改稿标题' }).waitFor();
    await dragInPreview(contents.getByRole('button', { name: '移动图层', exact: true }), 26, 16);
    assert.ok(Number(await canvas.getByRole('spinbutton', { name: '水平位移', exact: true }).inputValue()) > 0);
    const resize = contents.getByRole('button', { name: '调整图层大小', exact: true });
    await dragInPreview(resize, 12, 20);
    assert.ok(Number(await canvas.getByRole('spinbutton', { name: '高度', exact: true }).inputValue()) > 0);
    await canvas.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await canvas.getByRole('spinbutton', { name: '高度', exact: true }).inputValue(), '');
    await canvas.getByRole('textbox', { name: '添加批注' }).fill('让这个标题的对比更清楚');
    await canvas.getByRole('button', { name: '保存批注' }).click();
    await canvas.getByText('让这个标题的对比更清楚', { exact: true }).waitFor();
    await editCanvas.click();

    await chatOnly.click();
    const addMaterials = page.getByRole('button', { name: '添加设计资料', exact: true });
    const requestsBeforeMaterials = calls.length;
    await addMaterials.click();
    const materials = page.getByRole('dialog', { name: '设计资料', exact: true });
    await materials.waitFor();
    assert.equal(await canvas.isVisible(), false);
    const imports = materials.getByRole('group', { name: '导入设计资料', exact: true });
    assert.deepEqual(await imports.locator('[data-icon]').evaluateAll((icons) => icons.map((icon) => icon.dataset.icon)), ['image', 'file', 'canvas']);
    if (composerPreview) await imports.screenshot({ path: join(composerPreview, 'materials-menu.png'), animations: 'disabled' });
    await imports.getByLabel('导入 DESIGN.md').setInputFiles({ name: 'DESIGN.md', mimeType: 'text/markdown', buffer: Buffer.from('主色 #156655') });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="设计系统"]')?.value === '主色 #156655');
    await materials.getByRole('textbox', { name: '设计系统名称' }).fill('晚风品牌');
    await materials.getByRole('button', { name: '保存到设计系统库' }).click();
    await materials.getByRole('combobox', { name: '本机设计系统' }).selectOption('晚风品牌');
    await materials.getByRole('button', { name: '使用设计系统' }).click();
    await materials.getByRole('textbox', { name: '文字参考', exact: true }).fill('图书活动参考资料');
    await materials.getByLabel('导入文字参考').setInputFiles({
      name: 'tokens.css', mimeType: 'text/css', buffer: Buffer.from(':root { --ink: #193948; }'),
    });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="文字参考"]')?.value.includes('tokens.css'));
    const reference = await page.evaluate(() => {
      const preview = document.createElement('canvas');
      preview.width = preview.height = 24;
      const paint = preview.getContext('2d');
      paint.fillStyle = '#156655';
      paint.fillRect(0, 0, 24, 24);
      return preview.toDataURL('image/png').split(',')[1];
    });
    const [attachmentChooser] = await Promise.all([
      page.waitForEvent('filechooser'), imports.getByText('添加参考图片', { exact: true }).click(),
    ]);
    await attachmentChooser.setFiles({
      name: 'brand.png', mimeType: 'image/png',
      buffer: Buffer.from(reference, 'base64'),
    });
    await materials.getByText('brand.png', { exact: true }).waitFor({ timeout: 6000 });
    await materials.getByRole('checkbox', { name: '设计系统', exact: true }).check();
    await materials.getByRole('checkbox', { name: '参考资料', exact: true }).check();
    await materials.getByRole('checkbox', { name: '当前版本的画布修改和批注', exact: true }).check();
    await materials.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(await addMaterials.evaluate((button) => button === document.activeElement), true);
    const queuedMaterials = page.locator('.vc-context-attachment');
    assert.equal(await queuedMaterials.count(), 3);
    assert.equal(calls.length, requestsBeforeMaterials, 'Editing and selecting references stays local until send');
    if (composerPreview) await page.screenshot({ path: join(composerPreview, 'composer-materials.png'), animations: 'disabled' });
    await splitView.click();
    await composer.fill('把标题改成晚风夜读，保留栏目');
    await send.click();
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();
    const revisions = calls.filter(item => item.op === 'send' && item.mode === 'design');
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].sessionId, revisions[1].sessionId);
    assert.equal(revisions[0].prompt, brief);
    assert.equal(revisions[0].designContext, undefined);
    assert.equal(revisions[1].prompt, '把标题改成晚风夜读，保留栏目');
    assert.match(revisions[1].designContext.text, /主色 #156655/);
    assert.match(revisions[1].designContext.text, /图书活动参考资料/);
    assert.match(revisions[1].designContext.text, /--ink: #193948/);
    assert.match(revisions[1].designContext.text, /本地改稿标题/);
    assert.match(revisions[1].designContext.text, /让这个标题的对比更清楚/);
    assert.match(revisions[1].designContext.images[0].dataUrl, /^data:image\/(jpeg|png|webp);base64,/);
    const versions = canvas.getByRole('combobox', { name: '设计版本', exact: true });
    await chatOnly.click();
    await messages.locator('article').first().getByRole('button', { name: '查看画板', exact: true }).click();
    assert.equal(await versions.inputValue(), revisions[0].turnId);
    await contents.getByRole('heading', { name: '本地改稿标题' }).waitFor();
    const exportControl = canvas.getByRole('button', { name: '导出', exact: true });
    await exportControl.click();
    const exportMenu = canvas.getByRole('menu', { name: '导出格式', exact: true });
    await exportMenu.getByRole('menuitem', { name: '下载 ZIP', exact: true }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await canvas.locator('.vc-export-menu').evaluate(element => element.inert), true);
    await exportMenu.waitFor({ state: 'hidden' });
    assert.equal(await exportControl.evaluate(element => element === document.activeElement), true);
    await exportControl.click();
    const savedDownload = page.waitForEvent('download');
    await exportMenu.getByRole('menuitem', { name: '下载 HTML', exact: true }).click();
    const downloaded = await savedDownload;
    const html = await readFile(await downloaded.path(), 'utf8');
    assert.match(html, /本地改稿标题/);
    assert.match(html, /周五读书会/);
    assert.match(html, /Content-Security-Policy/i);
    assert.match(html, /script-src 'sha256-/);
    assert.doesNotMatch(html, /fixture-script|https:\/\/preview\.invalid|allow-scripts/i);
    await versions.selectOption('');
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();
    if (process.env.DSH_VPS_DESIGN_SCREENSHOT) await page.screenshot({ path: process.env.DSH_VPS_DESIGN_SCREENSHOT });

    await composer.fill('测试最后一版未闭合');
    await send.click();
    await messages.locator('article').last().getByText('已完成', { exact: true }).waitFor();
    assert.equal(calls.find(item => item.op === 'send' && item.prompt === '测试最后一版未闭合').designContext, undefined);
    assert.equal(await versions.locator('option').count(), 3, 'An unclosed artifact cannot add a version.');
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();

    await page.getByRole('button', { name: '请概括项目结构', exact: true }).click();
    await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
    assert.equal(await canvas.count(), 0);
    await page.getByRole('button', { name: brief + '，设计会话', exact: true }).click();
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();
    await versions.selectOption(revisions[0].turnId);
    await contents.getByRole('heading', { name: '本地改稿标题' }).waitFor();
    await versions.selectOption('');
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();

    preset = { ...preset, sessions: [...saved.values()].map(({ id, title, mode }) => ({ id, title, mode })) };
    await page.reload();
    await page.getByRole('button', { name: brief + '，设计会话', exact: true }).click();
    await versions.selectOption(revisions[0].turnId);
    await contents.getByRole('heading', { name: '本地改稿标题' }).waitFor();
    await canvas.getByRole('button', { name: '设计资料' }).click();
    assert.equal(await materials.getByRole('textbox', { name: '设计系统', exact: true }).inputValue(), '主色 #156655');
    assert.equal(await materials.getByRole('checkbox', { name: '参考资料', exact: true }).isChecked(), false);
    await materials.getByRole('button', { name: '完成', exact: true }).click();
    await versions.selectOption('');

    await page.setViewportSize({ width: 700, height: 760 });
    const viewMode = page.getByRole('group', { name: '设计视图', exact: true });
    await splitView.waitFor({ state: 'hidden' });
    await viewMode.getByRole('button', { name: '画布', exact: true }).click();
    await contents.getByRole('heading', { name: '晚风夜读' }).waitFor();
    await viewMode.getByRole('button', { name: '对话', exact: true }).click();
    await composer.waitFor();

    await page.setViewportSize({ width: 1272, height: 822 });
    for (const brief of ['测试生成时补充同一轮', '测试生成时补充断线']) {
      await page.getByRole('button', { name: '新建设计', exact: true }).click();
      await composer.fill(brief);
      await send.click();
      const steer = page.getByRole('button', { name: '发送补充', exact: true });
      await steer.waitFor();
      assert.equal(await messages.locator('.vc-answer .vc-markdown').count(), 0);
      assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).isEnabled(), true);
      const original = calls.find(item => item.op === 'send' && item.prompt === brief);
      const supplement = '把当前标题改成晚风夜读';
      await composer.fill(supplement);
      await canvasOnly.click();
      assert.equal(await composer.isVisible(), false);
      await splitView.click();
      assert.equal(await composer.inputValue(), supplement);
      if (brief.endsWith('断线')) {
        await steer.click();
        const check = page.getByRole('button', { name: '查询原任务', exact: true });
        await check.waitFor();
        assert.equal(await composer.inputValue(), supplement);
        assert.equal(await steer.isDisabled(), true);
        await check.click();
      } else {
        await composer.press('Enter');
      }
      const notes = messages.getByRole('list', { name: '本轮补充', exact: true });
      await notes.getByText('已送达', { exact: true }).waitFor();
      assert.equal(await notes.getByText(supplement, { exact: true }).count(), 1);
      assert.equal(await composer.inputValue(), '');
      const dispatched = calls.filter(item => item.op === 'steer' && item.sessionId === original.sessionId);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].turnId, original.turnId);
      assert.equal(dispatched[0].prompt, supplement);
      assert.equal(await notes.locator('li').getAttribute('data-steer-id'), dispatched[0].steerId);

      const late = '准备提交时已结束的草稿';
      await composer.fill(late);
      steerFixtures.get(original.sessionId).complete = true;
      const startNew = page.getByRole('button', { name: '作为新一轮发送', exact: true });
      await startNew.waitFor();
      await composer.press('Enter');
      assert.equal(await composer.inputValue(), late);
      assert.equal(await startNew.isEnabled(), true);
      assert.equal(calls.filter(item => ['send', 'steer'].includes(item.op) && item.sessionId === original.sessionId).length, 2);
    }

    const options = page.getByRole('group', { name: '发送设置', exact: true });
    const inputCard = page.locator('form.vc-composer');
    assert.equal(await inputCard.evaluate((card) => getComputedStyle(card).colorScheme), 'light');
    const modeControl = options.getByRole('button', { name: '模式', exact: true });
    const contextControl = options.getByRole('img', { name: '上下文用量', exact: true });
    const modelControl = options.getByRole('button', { name: '模型', exact: true });
    const modePanel = page.getByRole('dialog', { name: '模式', exact: true });
    const contextTooltip = page.getByRole('tooltip', { name: '上下文用量', exact: true });
    const modelPanel = page.getByRole('dialog', { name: '模型', exact: true });
    const closePanel = async (panel) => {
      await panel.getByRole('button', { name: '关闭', exact: true }).click();
      await options.locator('button[aria-expanded=true]').waitFor({ state: 'detached' });
    };
    const settleMotion = (surface) => surface.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    assert.equal(modelReads, 0);
    const sendsBeforeModeChange = calls.filter(({ op }) => op === 'send').length;
    await page.getByRole('button', { name: '新对话', exact: true }).first().click();
    const modeDraft = '切换至设计仍保留的草稿';
    await composer.fill(modeDraft);
    await modeControl.click();
    const chatChoice = modePanel.getByRole('button', { name: '对话', exact: true });
    const designChoice = modePanel.getByRole('button', { name: '设计', exact: true });
    assert.equal(await chatChoice.getAttribute('aria-pressed'), 'true');
    assert.equal(await chatChoice.locator('[data-icon=chat]').isVisible(), true);
    assert.equal(await chatChoice.locator('[data-icon=check]').isVisible(), true);
    assert.equal(await designChoice.locator('[data-icon=canvas]').isVisible(), true);
    assert.equal(await designChoice.locator('[data-icon=check]').isVisible(), false);
    if (composerPreview) await modePanel.screenshot({ path: join(composerPreview, 'mode-menu.png'), animations: 'disabled' });
    await designChoice.click();
    await modePanel.waitFor({ state: 'hidden' });
    assert.equal(await composer.inputValue(), modeDraft);
    assert.match(await modeControl.innerText(), /设计/);
    assert.equal(calls.filter(({ op }) => op === 'send').length, sendsBeforeModeChange);
    const requestsBeforeHover = calls.length;
    await composer.focus();
    await contextControl.hover();
    await contextTooltip.getByText('尚无 VPS 上下文用量报告。', { exact: true }).waitFor();
    assert.equal(await contextControl.textContent(), '');
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
    assert.equal(await contextControl.evaluate((element) => element.tabIndex), -1);
    assert.equal(await contextTooltip.locator('[data-icon=context]').isVisible(), true);
    assert.equal(await contextTooltip.getByRole('progressbar').count(), 0);
    await contextControl.click();
    assert.equal(await contextControl.getAttribute('aria-haspopup'), null);
    assert.equal(await page.getByRole('dialog', { name: '上下文', exact: true }).count(), 0);
    await page.mouse.move(4, 4);
    await contextTooltip.waitFor({ state: 'hidden' });
    assert.equal(calls.length, requestsBeforeHover);
    await modelControl.click();
    await modelPanel.getByRole('button', { name: '重试读取模型' }).click();
    const modelName = modelPanel.getByRole('button', { name: /^切换模型，/ });
    const modelList = modelPanel.getByRole('radiogroup', { name: '模型选择', exact: true });
    const effortSlider = modelPanel.getByRole('slider', { name: '思考强度', exact: true });
    await effortSlider.waitFor();
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '低');
    assert.equal(await modelList.count(), 0);
    assert.match(await modelName.innerText(), /测试快速模型/);
    const effortScale = modelPanel.locator('.vc-effort-scale');
    const effortThumb = modelPanel.locator('.vc-effort-thumb');
    await settleMotion(modelPanel);
    const thumbStart = await effortThumb.boundingBox();
    await effortSlider.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '中');
    assert.ok(await effortScale.evaluate((element) => element.getAnimations().some(
      (animation) => animation.transitionProperty === '--vc-effort-used' && animation.effect.getTiming().duration === 160)));
    await settleMotion(effortScale);
    assert.ok((await effortThumb.boundingBox()).x > thumbStart.x);
    assert.ok(await effortScale.evaluate((element) => {
      const track = element.querySelector('.vc-effort-track').getBoundingClientRect();
      const progress = parseFloat(getComputedStyle(element.querySelector('.vc-effort-progress'), '::before').width);
      const thumb = element.querySelector('.vc-effort-thumb').getBoundingClientRect();
      return Math.abs(track.left + progress - (thumb.left + thumb.width / 2)) <= 1;
    }));
    await modelName.click();
    const disclosure = modelPanel.locator('.vc-model-disclosure');
    assert.ok(await disclosure.evaluate((element) => element.getAnimations().some((animation) => animation.transitionProperty === 'grid-template-rows')));
    await settleMotion(modelPanel);
    assert.equal(await modelList.getByRole('radio', { name: '测试快速模型', exact: true }).isChecked(), true);
    const lastModel = modelList.getByRole('radio', { name: '测试候选 8', exact: true });
    await lastModel.waitFor({ state: 'attached' });
    assert.ok(await modelList.evaluate((list) => list.scrollHeight > list.clientHeight));
    assert.equal(await modelPanel.locator('select, [popover]').count(), 0);
    await lastModel.focus();
    await page.keyboard.press('Space');
    assert.equal(await lastModel.isChecked(), true);
    await closePanel(modelPanel);
    await modelControl.click();
    assert.equal(await modelList.count(), 0);
    await modelName.click();
    await page.waitForFunction(() => {
      const list = document.querySelector('.vc-model-list');
      const row = list?.querySelector('input:checked')?.parentElement;
      return row && row.offsetTop >= list.scrollTop && row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight + 1;
    });
    assert.equal(await lastModel.isChecked(), true);
    await modelList.getByText('测试视觉模型', { exact: true }).click();
    assert.equal(await modelList.getByRole('radio', { name: '测试视觉模型', exact: true }).isChecked(), true);
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '中');
    await page.keyboard.press('Escape');
    await modelList.waitFor({ state: 'hidden' });
    assert.equal(await modelPanel.isVisible(), true);
    await settleMotion(modelPanel);
    const rail = modelPanel.locator('.vc-effort-track');
    assert.equal(await rail.locator('.vc-effort-steps span').count(), 4);
    assert.ok(await rail.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.height >= 18 && Array.from(element.querySelectorAll('.vc-effort-steps span')).every((step) => {
        const mark = step.getBoundingClientRect();
        return mark.top >= bounds.top && mark.bottom <= bounds.bottom;
      });
    }));
    const effortLabel = await modelPanel.locator('.vc-effort-current').boundingBox();
    const modelLabel = await modelPanel.locator('.vc-model-trigger-label').boundingBox();
    assert.ok(effortLabel.y + effortLabel.height <= modelLabel.y &&
      Math.abs(effortLabel.x + effortLabel.width / 2 - modelLabel.x - modelLabel.width / 2) < 6);
    const sliderTrack = await effortSlider.boundingBox();
    const middle = sliderTrack.y + sliderTrack.height / 2;
    await page.mouse.move(sliderTrack.x + 7, middle);
    await page.mouse.down();
    assert.equal(await effortScale.evaluate((element) => getComputedStyle(element).transitionDuration), '0.08s');
    await page.mouse.move(sliderTrack.x + sliderTrack.width - 7, middle, { steps: 4 });
    await page.mouse.up();
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '最高');
    assert.ok(Math.abs((await effortSlider.boundingBox()).y - sliderTrack.y) <= 1);
    await modelPanel.getByRole('button', { name: '恢复模型默认', exact: true }).click();
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '中');
    await effortSlider.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '高');
    await closePanel(modelPanel);
    assert.equal(await modelControl.evaluate((button) => button === document.activeElement), true);
    await send.click();
    await messages.locator('article').last().getByText('已完成', { exact: true }).waitFor();
    const explicitSelection = calls.find(({ op, prompt }) => op === 'send' && prompt === modeDraft);
    assert.equal(explicitSelection.mode, 'design');
    assert.equal(explicitSelection.model, 'fixture-visual');
    assert.equal(explicitSelection.effort, 'high');

    async function checkContextReport() {
      await contextControl.hover();
      await contextTooltip.getByText('当前轮次的 VPS 报告', { exact: true }).waitFor();
      for (const value of ['12,345 tokens', '128,000 tokens', '9.6%', 'fixture-visual'])
        assert.equal(await contextTooltip.getByText(value, { exact: true }).count(), 1);
      assert.equal(await contextTooltip.getByRole('progressbar', { name: '上下文占用' }).getAttribute('value'), '12345');
      await page.mouse.move(4, 4);
      await contextTooltip.waitFor({ state: 'hidden' });
    }
    await checkContextReport();
    await modelControl.click();
    await settleMotion(modelPanel);
    const modelButton = await modelControl.boundingBox();
    const anchoredPanel = await modelPanel.boundingBox();
    assert.equal(await modelPanel.evaluate((panel) => getComputedStyle(panel, '::backdrop').backgroundColor), 'rgba(0, 0, 0, 0)');
    const chatPane = await messages.boundingBox();
    assert.ok(Math.abs(anchoredPanel.y + anchoredPanel.height + 8 - modelButton.y) < 2, JSON.stringify({ modelButton, anchoredPanel }));
    assert.ok(anchoredPanel.x <= modelButton.x + 1 && anchoredPanel.x + anchoredPanel.width >= modelButton.x + modelButton.width,
      JSON.stringify({ modelButton, anchoredPanel }));
    assert.ok(anchoredPanel.x >= chatPane.x && anchoredPanel.x + anchoredPanel.width <= chatPane.x + chatPane.width);
    if (composerPreview) await modelPanel.screenshot({ path: join(composerPreview, 'model-slider.png'), animations: 'disabled' });
    await modelName.click();
    if (composerPreview) await modelPanel.screenshot({ path: join(composerPreview, 'model-options.png'), animations: 'disabled' });
    const inherited = modelList.getByRole('radio', { name: '沿用会话设置', exact: true });
    await inherited.focus();
    await page.keyboard.press('Space');
    assert.equal(await inherited.isChecked(), true);
    await page.mouse.click(6, 6);
    await modelPanel.waitFor({ state: 'hidden' });
    await options.locator('[data-control=model][aria-expanded=false]').waitFor();
    assert.equal(modelReads, 2, 'The loaded VPS catalog is reused for this target');

    await modeControl.click();
    await modePanel.waitFor();
    await modeControl.click();
    await modePanel.waitFor({ state: 'hidden' });
    await modeControl.click();
    await modePanel.getByRole('button', { name: '对话', exact: true }).click();
    assert.equal(await messages.locator('article').count(), 0);
    await page.getByRole('button', { name: modeDraft + '，设计会话', exact: true }).click();
    await checkContextReport();
    await composer.fill('在原线程沿用会话设置');
    await send.click();
    await messages.locator('article').last().getByText('已完成', { exact: true }).waitFor();
    const inheritedSelection = calls.find(({ op, prompt }) => op === 'send' && prompt === '在原线程沿用会话设置');
    assert.equal(inheritedSelection.sessionId, explicitSelection.sessionId);
    assert.equal(inheritedSelection.model, undefined);
    assert.equal(inheritedSelection.effort, undefined);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.equal(await inputCard.evaluate((card) => getComputedStyle(card).colorScheme), 'dark');
    await modelControl.click();
    await settleMotion(modelPanel);
    const drawer = await modelPanel.boundingBox();
    assert.ok(drawer.x >= 0 && drawer.x + drawer.width <= 360, JSON.stringify(drawer));
    if (composerPreview) await page.screenshot({ path: join(composerPreview, 'composer-narrow.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await modelPanel.waitFor({ state: 'hidden' });
    await options.locator('[data-control=model][aria-expanded=false]').waitFor();
    assert.equal(await modelControl.evaluate((button) => button === document.activeElement), true);
    const composerFits = await options.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(composerFits, true);
    assert.equal(await contextControl.textContent(), '');
    await contextControl.hover();
    await contextTooltip.getByText('较早轮次的 VPS 报告', { exact: true }).waitFor();
    for (const value of ['12,345 tokens', '128,000 tokens', '9.6%'])
      assert.equal(await contextTooltip.getByText(value, { exact: true }).isVisible(), true);
    const tooltip = await contextTooltip.boundingBox();
    assert.ok(tooltip.x >= 0 && tooltip.x + tooltip.width <= 360, JSON.stringify(tooltip));
    await contextTooltip.hover();
    if (composerPreview) await contextTooltip.screenshot({ path: join(composerPreview, 'context-hover.png'), animations: 'disabled' });
    assert.equal(await contextTooltip.isVisible(), true);
    await page.keyboard.press('Escape');
    await contextTooltip.waitFor({ state: 'hidden' });
    const meter = await contextControl.locator('.vc-context-meter').evaluate((element) => parseFloat(element.style.getPropertyValue('--vc-used')));
    assert.ok(meter > 9.6 && meter < 9.7);
    const controls = await Promise.all([addMaterials, modeControl, contextControl, modelControl, send].map((button) => button.boundingBox()));
    for (let index = 1; index < controls.length; index++) {
      const before = controls[index - 1];
      const after = controls[index];
      assert.ok(before.x + before.width <= after.x + 1 && Math.abs(before.y + before.height / 2 - after.y - after.height / 2) <= 1,
        JSON.stringify(controls));
    }
    const transparent = 'rgba(0, 0, 0, 0)';
    await page.mouse.move(4, 4);
    await settleMotion(options);
    const idleButtons = await options.locator('button').evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button);
      return { border: style.borderTopColor, background: style.backgroundColor, primary: button.classList.contains('vc-primary') };
    }));
    for (const button of idleButtons) {
      assert.equal(button.border, transparent);
      assert.equal(button.background !== transparent, button.primary);
    }
    await modeControl.hover();
    await settleMotion(modeControl);
    assert.notEqual(await modeControl.evaluate((button) => getComputedStyle(button).backgroundColor), transparent);
    assert.equal(await modeControl.evaluate((button) => getComputedStyle(button).borderTopColor), transparent);
    await addMaterials.focus();
    await page.keyboard.press('Tab');
    assert.equal(await modeControl.evaluate((button) => button === document.activeElement && getComputedStyle(button).outlineStyle === 'solid'), true);
    if (composerPreview) {
      await page.mouse.move(4, 4);
      await composer.fill('为晚风书店的首页加一段活动介绍。保留移动端布局，并把主按钮改成深一点的绿色。');
      await inputCard.screenshot({ path: join(composerPreview, 'composer-preview.png'), animations: 'disabled' });
      await composer.fill('');
    }
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    await page.setViewportSize({ width: 1272, height: 822 });

    await modelControl.click();
    const modelSurface = page.locator('.vc-composer-panel[aria-label="模型"]');
    const entryMotion = await modelSurface.evaluate((element) => element.getAnimations().map((animation) => animation.transitionProperty));
    assert.ok(entryMotion.includes('opacity') && entryMotion.includes('translate'), JSON.stringify(entryMotion));
    await settleMotion(modelPanel);
    const exit = await modelSurface.evaluate((element) => {
      element.hidePopover();
      return { connected: element.isConnected, open: element.matches(':popover-open'),
        moving: element.getAnimations().some((animation) => animation.transitionProperty === 'opacity') };
    });
    assert.deepEqual(exit, { connected: true, open: false, moving: true });
    await modelSurface.waitFor({ state: 'detached' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await modelControl.click();
    const previousEffort = await effortSlider.inputValue();
    await effortSlider.focus();
    await page.keyboard.press(previousEffort === '0' ? 'End' : 'Home');
    assert.notEqual(await effortSlider.inputValue(), previousEffort);
    assert.equal(await effortScale.evaluate((element) => element.getAnimations().length), 0);
    await modelName.click();
    assert.equal(await modelPanel.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);
    await page.keyboard.press('Escape');
    await modelList.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await modelSurface.waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    if (showcase) {
      const demo = {
        id: '5af709f4-cef4-4ad9-8d35-43792bfc5bf2', title: '雾潮灯塔活动海报', mode: 'design', canSend: true,
        turns: [{
          id: '42b27732-4528-44b3-9b05-453b023f67bb',
          prompt: '给「雾潮灯塔」限时探索活动做两套竖版海报。A 版角色居中，B 版左文右图。',
          state: 'complete', reply: showcase, activity: [],
        }],
      };
      saved.set(demo.id, demo);
      preset = { ...preset, sessions: [{ id: demo.id, title: demo.title, mode: demo.mode }] };
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.getByRole('button', { name: '雾潮灯塔活动海报，设计会话', exact: true }).click();
      await contents.getByRole('heading', { name: '雾潮灯塔', exact: true }).waitFor();
      await canvas.getByRole('button', { name: '移动', exact: true }).click();
      await page.mouse.move(1200, 34);
      await page.screenshot({ path: join(previewDirectory, 'design-desktop.png'), animations: 'disabled' });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: join(previewDirectory, 'design-dark.png'), animations: 'disabled' });
      await page.evaluate(() => { delete document.documentElement.dataset.theme; });
      await page.setViewportSize({ width: 430, height: 820 });
      await canvasOnly.click();
      const narrow = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(narrow.scrollWidth <= narrow.width + 1, JSON.stringify(narrow));
      await page.screenshot({ path: join(previewDirectory, 'design-narrow.png'), animations: 'disabled' });
    }
    await t.test('local projects filter, file and restore chat and design without changing VPS packets', async () => {
      const fixtures = [
        { workspaceId: 'art-project-local', title: '游戏美术', path: 'C:/local-only-fixture/art' },
        { workspaceId: 'graphic-project-local', title: '平面设计', path: 'C:/local-only-fixture/graphic' },
      ];
      const legacy = saved.get(sends[0].sessionId);
      const sessions = () => [...saved.values()].map(({ id, title, mode }) => ({ id, title, mode }));
      preset = { ...preset, sessions: sessions() };
      const start = calls.length;
      await page.setViewportSize({ width: 1272, height: 822 });
      await page.reload();
      const filters = page.getByRole('group', { name: '本地项目', exact: true });
      const history = page.getByRole('navigation', { name: '会话记录', exact: true });
      const picker = page.getByRole('combobox', { name: '归入本地项目', exact: true });
      const unfiled = filters.getByRole('button', { name: '未归类', exact: true });
      const art = filters.getByRole('button', { name: fixtures[0].title, exact: true });
      const graphic = filters.getByRole('button', { name: fixtures[1].title, exact: true });
      const legacyButton = history.getByRole('button', { name: legacy.title, exact: true });
      await page.evaluate((items) => window.fixtureSetWorkspaces(items), fixtures);
      await unfiled.click();
      await legacyButton.click();
      await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
      assert.equal(await picker.inputValue(), '');
      const beforeMove = calls.length;
      await picker.selectOption(fixtures[0].workspaceId);
      await legacyButton.waitFor({ state: 'hidden' });
      assert.equal(calls.length, beforeMove);
      await art.click();
      await legacyButton.waitFor();
      await page.locator('.vc-new-actions').getByRole('button', { name: /新对话/ }).click();
      assert.equal(await picker.inputValue(), fixtures[0].workspaceId);
      await composer.fill('继续完善第一版草稿');
      await graphic.click();
      assert.equal(await composer.inputValue(), '继续完善第一版草稿');
      await page.getByRole('button', { name: '新建设计', exact: true }).click();
      assert.equal(await picker.inputValue(), fixtures[1].workspaceId);
      completeDesign = true;
      await composer.fill('为夏季活动制作横版海报');
      await send.click();
      const designRow = history.getByRole('button', { name: '为夏季活动制作横版海报，设计会话', exact: true });
      await designRow.waitFor();
      await contents.getByRole('heading', { name: '晚风书店', exact: true }).waitFor();

      preset = { ...preset, sessions: sessions() };
      await page.reload();
      await page.evaluate((items) => window.fixtureSetWorkspaces(items), fixtures);
      await graphic.click();
      await designRow.waitFor();
      assert.equal(await legacyButton.count(), 0);
      await art.click();
      await legacyButton.waitFor();
      assert.equal(await designRow.count(), 0);
      await legacyButton.click();
      await messages.getByRole('heading', { name: '项目包含三个主要模块。' }).waitFor();
      assert.equal(await picker.inputValue(), fixtures[0].workspaceId);
      await page.evaluate((items) => window.fixtureSetWorkspaces(items), [
        { ...fixtures[0], title: '游戏美术制作' }, fixtures[1],
      ]);
      await filters.getByRole('button', { name: '游戏美术制作', exact: true }).waitFor();
      assert.equal(await picker.inputValue(), fixtures[0].workspaceId);

      if (projectsPreview) {
        await page.screenshot({ path: join(projectsPreview, 'workbench-light.png'), animations: 'disabled' });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.screenshot({ path: join(projectsPreview, 'workbench-dark.png'), animations: 'disabled' });
        await page.evaluate(() => { delete document.documentElement.dataset.theme; });
      }
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByRole('button', { name: '会话', exact: true }).click();
      await filters.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
      if (projectsPreview) await page.screenshot({ path: join(projectsPreview, 'workbench-narrow.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 1272, height: 822 });

      await picker.selectOption('');
      await legacyButton.waitFor({ state: 'hidden' });
      await unfiled.click();
      await legacyButton.waitFor();
      const packets = calls.slice(start);
      assert.equal(packets.filter((packet) => packet.op === 'send').length, 1);
      assert.equal(packets.find((packet) => packet.op === 'send').settings.workspace, '/workspace/fixture');
      assert.doesNotMatch(JSON.stringify(packets), /(?:art-project-local|graphic-project-local|local-only-fixture|游戏美术|平面设计)/);
    });

    await t.test('Claude selects an API model within its own target and keeps effort on the VPS', async () => {
      targetId = 'e'.repeat(64);
      saved.clear();
      preset = { name: 'claude-fixture', settings: { ...preset.settings, host: 'claude-fixture.invalid', provider: 'claude' }, targetId, sessions: [] };
      await page.reload();
      await page.getByText('claude-fixture · 已配置', { exact: true }).waitFor();
      assert.equal(await chooser.getAttribute('data-provider'), 'claude');
      await modelControl.click();
      await modelPanel.getByRole('button', { name: /^切换模型，/ }).click();
      assert.equal(await modelPanel.getByRole('slider', { name: '思考强度' }).count(), 0);
      await modelPanel.getByText('Claude Opus', { exact: true }).click();
      await closePanel(modelPanel);
      await composer.fill('验证 Claude 模型');
      await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.op === 'send'),
        send.click(),
      ]);
      const packet = calls.findLast(item => item.op === 'send');
      assert.equal(packet.targetId, targetId);
      assert.equal(packet.settings.provider, 'claude');
      assert.equal(packet.model, 'opus');
      assert.equal(packet.effort, undefined);
    });

    await t.test('the tool palette shows only saved tools and switches without touching VPS configuration', async () => {
      saved.clear();
      targetId = 'f'.repeat(64);
      const connection = { ...preset.settings, host: 'provider-switch-fixture.invalid', provider: 'codex' };
      preset = { name: 'provider-switch-fixture', settings: connection, targetId, sessions: [] };
      await page.reload();
      await chooser.waitFor();
      assert.equal(await chooser.getAttribute('data-provider'), 'codex');
      const codexTheme = await expectToolTheme('codex', 'light', '#434e99');
      assert.equal(await workbench.getAttribute('data-theme-ripple'), null);
      await expectToolIcon(chooser, 'codex', 104);
      assert.equal(await chooser.innerText(),'');
      await openTools();
      assert.deepEqual(await toolNames(), ['Codex']);
      await page.keyboard.press('Escape');
      await palette.waitFor({state:'hidden'});
      assert.equal(await chooser.evaluate(button => button === document.activeElement),true);

      const configure = calls.length;
      await openToolSettings();
      await toolSetting('API 密钥').check();
      await settings.getByRole('button',{name:'取消',exact:true}).click();
      await openTools();
      assert.deepEqual(await toolNames(), ['Codex']);
      await page.keyboard.press('Escape');
      await palette.waitFor({state:'hidden'});
      await openToolSettings();
      assert.equal(await toolSetting('API 密钥').isChecked(),false);
      await expectToolIcon(settings.locator('.vc-tool-setting[data-tool-theme=codex]'), 'codex', 104);
      await expectToolIcon(settings.locator('.vc-tool-setting[data-tool-theme=claude-sdk]'), 'claude-sdk', 48);
      await expectToolIcon(settings.locator('.vc-tool-setting[data-tool-theme=claude-subscription]'), 'claude-code', 48);
      const apiAccent = await settings.locator('.vc-tool-setting[data-tool-theme=claude]').evaluate(row =>
        getComputedStyle(row).getPropertyValue('--vc-accent').trim());
      assert.equal(apiAccent, '#216656');
      await toolSetting('API 密钥').check();
      await toolSetting('Claude（订阅 SDK）').check();
      await saveTools.click();
      assert.equal(calls.length,configure);

      await composer.fill('保留在 Codex 对话中的草稿');
      const openMotion = await chooser.evaluate(async (button) => {
        button.focus();
        button.click();
        const panel = document.getElementById(button.getAttribute('aria-controls'));
        await new Promise(requestAnimationFrame);
        return panel.getAnimations().some(animation => animation.transitionProperty === 'clip-path');
      });
      assert.equal(openMotion,true);
      await palette.waitFor();
      assert.deepEqual(await toolNames(), ['Codex','API 密钥','Claude（订阅 SDK）']);
      await expectToolIcon(palette.getByRole('option', { name: 'Codex' }), 'codex', 104);
      await expectToolIcon(palette.getByRole('option', { name: 'API 密钥' }), 'key');
      await expectToolIcon(palette.getByRole('option', { name: 'Claude（订阅 SDK）' }), 'claude-sdk', 48);
      const geometry = await palette.evaluate(panel => {
        const options = [...panel.querySelectorAll('button')].map(element => element.getBoundingClientRect());
        return {
          evenlySpaced: Math.abs(options[2].x-options[1].x - (options[1].x-options[0].x)) < .5,
          horizontal: options.every(option => option.y === options[0].y),
          capsule: Number.parseFloat(getComputedStyle(panel).borderRadius) > panel.offsetHeight/2,
        };
      });
      assert.deepEqual(geometry,{evenlySpaced:true,horizontal:true,capsule:true});
      if (toolsPreview) await page.screenshot({path:join(toolsPreview,'tools-light.png'),animations:'disabled'});
      const begin = calls.length;
      targetId = 'a'.repeat(64);
      await page.keyboard.press('ArrowRight');
      const api = palette.getByRole('option',{name:'API 密钥',exact:true});
      assert.equal(await api.evaluate(option => option === document.activeElement),true);
      const rippleOrigin = await api.evaluate(option => {
        const icon = option.getBoundingClientRect();
        const frame = option.closest('[data-vps-chat]').getBoundingClientRect();
        return { x: icon.left + icon.width / 2 - frame.left, y: icon.top + icon.height / 2 - frame.top };
      });
      await page.keyboard.press('Enter');
      await api.and(palette.locator('[aria-selected=true]')).waitFor();
      const highlight = palette.locator('.vc-tool-highlight');
      await page.waitForFunction(() => document.querySelector('[data-vps-chat]').getAnimations({ subtree: true })
        .some(animation => animation.animationName === 'vc-theme-switch'));
      const highlightMotion = await highlight.evaluate(element =>
        element.getAnimations().map(animation => animation.transitionProperty));
      assert.ok(highlightMotion.includes('transform'));
      assert.ok(!highlightMotion.includes('background-color'));
      try {
        const reveal = await workbench.evaluate(async (root) => {
          const pigment = root.getAnimations({ subtree: true })
            .filter(animation => animation.animationName === 'vc-theme-switch');
          pigment.forEach(animation => animation.pause());
          await Promise.all(pigment.map(animation => animation.ready));
          const mask = document.querySelector('[data-vc-pigment] mask');
          const menu = root.querySelector('.vc-tool-palette:popover-open');
          async function frame(time) {
            pigment.forEach(animation => { animation.currentTime = time; });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const style = getComputedStyle(root, '::view-transition-new(root)');
            return {
              maskImage: style.maskImage,
              front: mask.querySelector('[data-vc-diffusion-front]').getAttribute('d'),
              paths: [...mask.querySelectorAll('path')].map(path => path.getAttribute('d')).filter(Boolean),
              menuCoverage: parseFloat(menu.style.getPropertyValue('--vc-menu-theme-coverage')),
            };
          }
          const early = await frame(10);
          const late = await frame(904);
          const bloom = await frame(480);
          const origin = mask.querySelector('g').transform.baseVal.getItem(0).matrix;
          return {
            x: origin.e,
            y: origin.f,
            early, bloom, late,
            effect: root.dataset.themeRipple,
            vectorMask: `url("#${mask.id}")`,
            hasBitmap: Boolean(mask.querySelector('image')),
            blurPasses: mask.parentElement.querySelectorAll('feGaussianBlur').length,
            localGradients: mask.parentElement.querySelectorAll('radialGradient').length,
            oldMask: getComputedStyle(root, '::view-transition-old(root)').maskImage,
            oldMaskComposite: getComputedStyle(root, '::view-transition-old(root)').maskComposite.split(',')[0],
            dye: getComputedStyle(root, '::view-transition-image-pair(root)').backgroundColor,
            layers: pigment.length,
          };
        });
        assert.ok(Math.abs(reveal.x - rippleOrigin.x) < 2 && Math.abs(reveal.y - rippleOrigin.y) < 2);
        assert.equal(reveal.layers, 2);
        assert.equal(reveal.effect, 'pigment');
        assert.equal(await workbench.locator('[data-vc-binary]').count(), 0);
        assert.equal(reveal.bloom.maskImage, reveal.vectorMask);
        assert.ok(reveal.oldMask.endsWith(reveal.vectorMask));
        assert.equal(reveal.hasBitmap, false);
        assert.equal(reveal.blurPasses, 1);
        assert.equal(reveal.localGradients, 1);
        assert.ok(reveal.bloom.paths.length > reveal.early.paths.length);
        assert.notEqual(reveal.bloom.front, reveal.late.front);
        assert.ok(reveal.early.menuCoverage >= 0 && reveal.early.menuCoverage < 100);
        assert.equal(reveal.bloom.menuCoverage, 100);
        assert.equal(reveal.oldMaskComposite, 'exclude');
        assert.equal(reveal.dye, 'rgb(33, 102, 86)');
        assert.ok(await palette.isVisible(), 'The tool switcher stays above the dye');
        if (toolsPreview) await page.screenshot({path:join(toolsPreview,'theme-pigment.png')});
      } finally {
        await workbench.evaluate(root => root.getAnimations({ subtree: true })
          .filter(animation => animation.animationName === 'vc-theme-switch')
          .forEach(animation => animation.play()));
      }
      await page.waitForFunction(() => !document.querySelector('[data-vps-chat]').hasAttribute('data-theme-ripple'));
      assert.equal(await page.locator('[data-vc-pigment]').count(), 0);
      assert.equal(await palette.evaluate(panel => panel.style.getPropertyValue('--vc-menu-theme-coverage')), '');
      await page.waitForFunction(() => {
        const panel = document.querySelector('.vc-tool-palette:popover-open');
        if (!panel) return false;
        const marker = panel.querySelector('.vc-tool-highlight').getBoundingClientRect();
        const active = panel.querySelector('[aria-selected=true]').getBoundingClientRect();
        return Math.abs(marker.left+marker.width/2 - active.left-active.width/2) < 2;
      });
      await page.getByText('provider-switch-fixture · 已配置', { exact: true }).waitFor();
      const apiTheme = await expectToolTheme('claude', 'light', '#216656');
      assert.notEqual(apiTheme.canvas, codexTheme.canvas);
      await highlight.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
      assert.equal(await highlight.evaluate(element => getComputedStyle(element).backgroundColor), apiTheme.primary);
      if (toolsPreview) await page.screenshot({path:join(toolsPreview,'api-light.png'),animations:'disabled'});
      assert.equal(await composer.inputValue(), '');
      assert.deepEqual(calls.slice(begin), [{ op: 'list', settings: { ...connection, provider: 'claude' } }]);
      const overlayOutside = page.getByRole('heading', {name:'开始一段对话'});
      await overlayOutside.click();
      const closeMotion = await page.locator('.vc-tool-palette').evaluate(element =>
        element.getAnimations().some(animation => animation.transitionProperty === 'clip-path'));
      assert.equal(closeMotion,true);
      await palette.waitFor({state:'hidden'});

      await setDesktopDark(true);
      await expectToolTheme('claude', 'dark', '#8cd9bf');
      await setDesktopDark(false);
      await openToolSettings();
      await toolSetting('API 密钥').uncheck();
      await saveTools.click();
      assert.equal(await composer.isDisabled(),true);
      assert.equal(await chooser.getAttribute('data-provider'),'');
      assert.equal(await workbench.getAttribute('data-tool-theme'), null);
      await chooser.press('ArrowDown');
      assert.deepEqual(await toolNames(), ['Codex','Claude（订阅 SDK）']);
      targetId = preset.targetId;
      const codex = palette.getByRole('option', { name: 'Codex', exact: true });
      await palette.evaluate(panel => Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
      const click = await codex.evaluate(option => {
        const bounds = option.getBoundingClientRect();
        const frame = option.closest('[data-vps-chat]').getBoundingClientRect();
        const x = Math.round(bounds.left + 8);
        const y = Math.round(bounds.top + 8);
        return { x, y, expectedX: x - frame.left, expectedY: y - frame.top,
          centerDistance: Math.hypot(x - bounds.left - bounds.width / 2, y - bounds.top - bounds.height / 2) };
      });
      assert.ok(click.centerDistance > 8, 'Click near the edge exercises the pointer coordinates');
      await page.mouse.click(click.x, click.y);
      await codex.and(palette.locator('[aria-selected=true]')).waitFor();
      await page.waitForFunction(() => document.querySelector('[data-vps-chat]').getAnimations({ subtree: true })
        .some(animation => animation.animationName === 'vc-theme-switch'));
      try {
        const result = await workbench.evaluate(async root => {
          const timeline = root.getAnimations({ subtree: true })
            .filter(animation => animation.animationName === 'vc-theme-switch');
          timeline.forEach(animation => animation.pause());
          await Promise.all(timeline.map(animation => animation.ready));
          const binary = root.querySelector('[data-vc-binary]');
          const glyphs = binary.querySelector('canvas[data-vc-binary-glyphs]');
          const menu = root.querySelector('.vc-tool-palette:popover-open');
          const pixels = glyphs.getContext('2d').getImageData(0, 0, Math.min(160, glyphs.width), Math.min(64, glyphs.height)).data;
          let cyan = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] && pixels[i + 1] > pixels[i] && pixels[i + 2] > pixels[i]) cyan++;
          }
          async function frame(time) {
            timeline.forEach(animation => { animation.currentTime = time; });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {
              bands: binary.querySelector('clipPath path').getAttribute('d'),
              reveal: binary.querySelector('mask path').getAttribute('d'),
              menu: parseFloat(menu.style.getPropertyValue('--vc-menu-theme-coverage')),
            };
          }
          const early = await frame(55);
          const end = await frame(1095);
          const middle = await frame(340);
          const matrix = binary.querySelector('mask > g').transform.baseVal.getItem(0).matrix;
          return {
            effect: root.dataset.themeRipple, x: matrix.e, y: matrix.f, early, middle, end,
            cyan, glyphsAtNativeSize: glyphs.width === Math.round(binary.viewBox.baseVal.width * devicePixelRatio) &&
              glyphs.height === Math.round(binary.viewBox.baseVal.height * devicePixelRatio),
            hiddenFromAT: binary.getAttribute('aria-hidden'),
            newMask: getComputedStyle(root,'::view-transition-new(root)').maskImage,
            binaryMask: `url("#${binary.querySelector('mask').id}")`,
          };
        });
        assert.equal(result.effect, 'binary');
        assert.ok(Math.abs(result.x - click.expectedX) < 1 && Math.abs(result.y - click.expectedY) < 1);
        assert.equal(result.hiddenFromAT, 'true');
        assert.equal(result.newMask, result.binaryMask);
        assert.equal(result.early.reveal, '');
        assert.ok(result.early.bands.length && result.middle.reveal.length && result.middle.bands.length);
        assert.ok(result.cyan > 100, 'The cached glyph layer contains the cyan 01 pattern');
        assert.equal(result.glyphsAtNativeSize, true);
        assert.notEqual(result.early.bands, result.middle.bands);
        assert.equal(result.early.menu, 0);
        assert.equal(result.middle.menu, 100);
        assert.equal(result.end.bands, '');
        assert.ok(result.end.reveal.length > result.middle.reveal.length);
        assert.equal(await page.locator('[data-vc-pigment]').count(), 0);
        if (toolsPreview) await page.screenshot({path:join(toolsPreview,'theme-binary.png')});
      } finally {
        await workbench.evaluate(root => root.getAnimations({ subtree: true })
          .filter(animation => animation.animationName === 'vc-theme-switch')
          .forEach(animation => animation.play()));
      }
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.querySelector('[data-vps-chat]').hasAttribute('data-theme-ripple'));
      const history = page.getByRole('navigation',{name:'会话记录'});
      await history.locator('.vc-session:not([aria-current=true])').click();
      assert.equal(await composer.inputValue(), '保留在 Codex 对话中的草稿');
      await page.reload();
      await chooser.waitFor();
      await page.setViewportSize({width:320,height:520});
      await setDesktopDark(true);
      await expectToolTheme('codex', 'dark', '#b2bfff');
      await expectToolIcon(chooser, 'codex', 104);
      await page.emulateMedia({reducedMotion:'reduce'});
      await openTools();
      assert.deepEqual(await toolNames(),['Codex','Claude（订阅 SDK）']);
      const narrow = await palette.evaluate(element => {
        const {left,right} = element.getBoundingClientRect();
        return left >= 0 && right <= innerWidth && getComputedStyle(element).colorScheme === 'dark' &&
          !element.getAnimations().length;
      });
      assert.equal(narrow,true);
      if (toolsPreview) await page.screenshot({path:join(toolsPreview,'tools-dark-narrow.png'),animations:'disabled'});
      await chooseTool('Claude（订阅 SDK）');
      await expectToolTheme('claude-sdk', 'dark', '#f1ac91');
      assert.equal(await workbench.getAttribute('data-theme-ripple'), null);
      assert.equal(await page.locator('[data-vc-pigment], [data-vc-binary]').count(), 0);
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.setViewportSize({width:1272,height:822});
      await setDesktopDark(false);
    });

    await t.test('Antigravity fits a wide window and reveals the new view as its elements fly out', async (scenario) => {
      const viewport = page.viewportSize();
      if (viewport) scenario.after(() => page.setViewportSize(viewport));
      await page.setViewportSize({ width: 2240, height: 1200 });
      saved.clear();
      targetId = '9'.repeat(64);
      preset = { name: 'antigravity-fixture', settings: { ...preset.settings, host: 'agy-fixture.invalid', provider: 'codex' },
        targetId, sessions: [] };
      await page.reload();
      await page.getByText('antigravity-fixture · 已配置', { exact: true }).waitFor();
      await openToolSettings();
      await expectToolIcon(settings.locator('.vc-tool-setting[data-tool-theme=antigravity]'), 'antigravity', 64);
      await toolSetting('Antigravity').check();
      await saveTools.click();
      await composer.fill('Codex 原有草稿');
      await workbench.evaluate(root => {
        const start = root.startViewTransition;
        const readView = () => {
          const editor = root.querySelector('textarea[aria-label="消息"]');
          return { tool: root.dataset.toolTheme, prompt: editor.placeholder, draft: editor.value };
        };
        root.startViewTransition = function(update) {
          root.startViewTransition = start;
          return start.call(root, async () => {
            const outgoing = readView();
            await update();
            root.fixtureViews = { outgoing, incoming: readView() };
          });
        };
      });
      await openTools();
      await expectToolIcon(palette.getByRole('option', { name: 'Antigravity', exact: true }), 'antigravity', 64);
      await chooseTool('Antigravity');
      await page.waitForFunction(() => document.querySelector('[data-vps-chat]').getAnimations({ subtree: true })
        .some(animation => animation.animationName === 'vc-theme-switch'));
      try {
        const report = await workbench.evaluate(async root => {
          const timeline = root.getAnimations({ subtree: true })
            .filter(animation => animation.animationName === 'vc-theme-switch');
          timeline.forEach(animation => animation.pause());
          await Promise.all(timeline.map(animation => animation.ready));
          const svg = root.querySelector('[data-vc-elements]');
          const mask = document.getElementById(svg.dataset.vcElements);
          const reveal = mask.querySelector('path');
          const elements = [...svg.querySelectorAll('[data-element]')];
          const view = svg.viewBox.baseVal;
          const probes = Array.from({ length: 200 }, (_, index) =>
            new DOMPoint(view.width * (index % 20 + .5) / 20, view.height * (Math.floor(index / 20) + .5) / 10));
          const frameBounds = svg.getBoundingClientRect();
          const tracked = ['H', 'Ar', 'Lr'].map(symbol => svg.querySelector(`[data-element="${symbol}"]`));
          async function frame(time) {
            timeline.forEach(animation => { animation.currentTime = time; });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const visible = elements.filter(node => {
              if (+node.getAttribute('opacity') <= .5) return false;
              const card = node.getBoundingClientRect();
              return card.left < frameBounds.right && card.right > frameBounds.left &&
                card.top < frameBounds.bottom && card.bottom > frameBounds.top;
            }).length;
            return {
              visible,
              revealed: probes.filter(point => reveal.isPointInFill(point)).length,
              pose: elements.map(node => node.getAttribute('transform')).join('|'),
              centers: tracked.map(node => {
                const transforms = node.transform.baseVal;
                const matrix = transforms.numberOfItems ? transforms.getItem(0).matrix : null;
                return matrix ? [matrix.e, matrix.f] : null;
              }),
            };
          }
          const early = await frame(40);
          const arriving = [await frame(410), await frame(655)];
          const parked = await frame(985);
          const held = await frame(1105);
          const flying = await frame(1520);
          const later = await frame(1690);
          const settled = await frame(1815);
          await frame(1060);
          const cards = elements.map((element) => element.getBoundingClientRect());
          const left = Math.min(...cards.map(({ left }) => left));
          const right = Math.max(...cards.map(({ right }) => right));
          const top = Math.min(...cards.map(({ top }) => top));
          const bottom = Math.max(...cards.map(({ bottom }) => bottom));
          const fits = left >= frameBounds.left && right <= frameBounds.right &&
            top >= frameBounds.top && bottom <= frameBounds.bottom;
          const occupied = Math.max((right - left) / frameBounds.width, (bottom - top) / frameBounds.height);
          return {
            effect: root.dataset.themeRipple, early, arriving, parked, held, flying, later, settled,
            fits, occupied,
            hidden: svg.getAttribute('aria-hidden'),
            numbers: elements.map(node => +node.dataset.atomicNumber).sort((a,b) => a - b),
            models: elements.filter(node => node.dataset.modelElement).map(node => node.dataset.modelElement),
            views: root.fixtureViews,
            mask: getComputedStyle(root,'::view-transition-new(root)').maskImage,
            expected: `url("#${mask.id}")`,
          };
        });
        assert.equal(report.effect, 'elements');
        assert.equal(report.hidden, 'true');
        assert.equal(report.fits, true);
        assert.ok(report.occupied >= .79);
        assert.deepEqual(report.numbers, Array.from({ length: 118 }, (_, index) => index + 1));
        assert.deepEqual(report.models, ['Hydrogen', 'Carbon', 'Neon', 'Argon']);
        assert.equal(report.early.visible, 0);
        assert.equal(report.early.revealed, 0);
        assert.ok(report.arriving.every(frame => frame.revealed === 0));
        assert.equal(report.parked.visible, 118);
        assert.equal(report.parked.revealed, 0);
        assert.deepEqual(report.held, report.parked);
        assert.ok(report.flying.visible > 0 && report.flying.revealed > 0);
        assert.ok(report.later.revealed > report.flying.revealed && report.later.revealed < 200);
        assert.ok(report.later.visible < report.flying.visible);
        for (const [index, [x, y]] of report.parked.centers.entries()) {
          const approaching = report.arriving.map(frame => frame.centers[index])
            .find(point => point && Math.hypot(x - point[0], y - point[1]) > 1);
          assert.ok(approaching);
          const [startX, startY] = approaching;
          const [endX, endY] = report.flying.centers[index];
          const incoming = [x - startX, y - startY];
          const outgoing = [endX - x, endY - y];
          const lengths = Math.hypot(...incoming) * Math.hypot(...outgoing);
          assert.ok(incoming[0] * outgoing[0] + incoming[1] * outgoing[1] > 0);
          assert.ok(Math.abs(incoming[0] * outgoing[1] - incoming[1] * outgoing[0]) < lengths * .005);
        }
        assert.equal(report.settled.visible, 0);
        assert.equal(report.settled.revealed, 200);
        assert.equal(report.mask, report.expected);
        assert.deepEqual(report.views, {
          outgoing: { tool: 'codex', prompt: '给 Codex 发消息', draft: 'Codex 原有草稿' },
          incoming: { tool: 'antigravity', prompt: '给 Antigravity 发消息', draft: '' },
        });
        assert.equal(await composer.getAttribute('readonly'), '');
        if (toolsPreview) await page.screenshot({path:join(toolsPreview,'theme-elements.png')});
      } finally {
        await workbench.evaluate(root => root.getAnimations({ subtree: true })
          .filter(animation => animation.animationName === 'vc-theme-switch')
          .forEach(animation => animation.play()));
      }
      await page.waitForFunction(() => !document.querySelector('[data-vps-chat]').hasAttribute('data-theme-ripple'));
      assert.equal(await workbench.locator('[data-vc-elements]').count(), 0);
      await expectToolTheme('antigravity', 'light', '#2867b5');
      await expectToolIcon(chooser, 'antigravity', 64);
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      await composer.fill('测试 Antigravity VPS 对话');
      await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.op === 'send'),
        send.click(),
      ]);
      const sent = calls.findLast(call => call.op === 'send');
      assert.equal(sent.settings.provider, 'antigravity');
      assert.equal(sent.targetId, targetId);
      assert.equal(sent.prompt, '测试 Antigravity VPS 对话');
      assert.equal(sent.model, undefined);
      assert.equal(sent.mode, undefined);
    });

    await t.test('the Claude subscription SDK uses the shared message list and composer', async () => {
      saved.clear();
      targetId = '7'.repeat(64);
      preset = { name:'sdk-fixture', settings:{...preset.settings, host:'sdk-fixture.invalid', provider:'claude-sdk'}, targetId, sessions:[] };
      await page.reload();
      await page.getByText('sdk-fixture · 已配置', {exact:true}).waitFor();
      assert.equal(await chooser.getAttribute('data-provider'),'claude-sdk');
      await expectToolTheme('claude-sdk', 'light', '#99492f');
      await expectToolIcon(chooser, 'claude-sdk', 48);
      await setDesktopDark(true);
      await expectToolTheme('claude-sdk', 'dark', '#f1ac91');
      if (toolsPreview) await page.screenshot({path:join(toolsPreview,'claude-sdk-dark.png'),animations:'disabled'});
      await setDesktopDark(false);
      await composer.fill('测试流式订阅 SDK');
      await composer.press('Enter');
      await page.getByText('增量第一段。', {exact:true}).waitFor();
      await page.getByText('增量第二段。', {exact:true}).waitFor();
      await page.getByRole('button',{name:'复制回复'}).waitFor();
      const packet = calls.findLast(item => item.op === 'send');
      assert.equal(packet.settings.provider,'claude-sdk');
      assert.equal(packet.targetId,targetId);
      assert.equal(packet.prompt,'测试流式订阅 SDK');
      assert.equal(await page.getByRole('region',{name:'Claude Code 订阅终端'}).count(),0);
      await page.getByRole('button',{name:'停止生成'}).click();
      await page.getByText('已停止',{exact:true}).waitFor();
      const stop = calls.findLast(item => item.op === 'stop');
      assert.equal(stop.settings.provider,'claude-sdk');
      assert.equal(stop.sessionId,packet.sessionId);
      assert.equal(stop.turnId,packet.turnId);
    });

    await t.test('settings animate and persist device preferences and independent tool profiles', async settingsTest => {
      settingsTest.after(async () => {
        failSettingsModels = false;
        if (page.isClosed()) return;
        await page.evaluate(() => localStorage.removeItem('dsh-vps-chat:workbench:v1'));
        await page.setViewportSize({ width: 1272, height: 822 });
      });
      saved.clear();
      targetId = '2'.repeat(64);
      preset = { name: 'settings-fixture', settings: { ...preset.settings, host: 'settings-fixture.invalid', provider: 'codex' },
        targetId, sessions: [] };
      await page.reload();
      await page.getByText('settings-fixture · 已配置', { exact: true }).waitFor();
      const settingsButton = page.getByRole('button', { name: 'VPS 设置', exact: true });
      const openedWithMotion = await settingsButton.evaluate(async button => {
        button.focus();
        button.click();
        await new Promise(requestAnimationFrame);
        const dialog = document.querySelector('dialog.vc-workbench-settings');
        return dialog.open && dialog.getAnimations().some(animation => animation.transitionProperty === 'opacity');
      });
      assert.equal(openedWithMotion, true);
      await settings.waitFor();
      const nav = settings.getByRole('navigation', { name: 'VPS 设置分类' });
      const tab = name => nav.getByRole('button', { name, exact: true });
      const profile = id => settings.locator(`.vc-tool-config:has(.vc-tool-setting[data-tool-theme="${id}"])`);
      if (settingsPreview) await page.screenshot({ path: join(settingsPreview, 'settings-tools.png'), animations: 'disabled' });
      const callsBeforePreferences = calls.length;
      const pageMotion = await tab('外观').evaluate(async button => {
        button.click();
        await new Promise(requestAnimationFrame);
        return button.closest('dialog').querySelector('.vc-settings-pane')
          .getAnimations().some(animation => animation.animationName === 'vc-settings-page-in');
      });
      assert.equal(pageMotion, true);
      await settings.getByRole('group', { name: '主题', exact: true }).getByRole('button', { name: '深色', exact: true }).click();
      const accent = settings.locator('details.vc-settings-disclosure');
      const menuMotion = await accent.evaluate(async details => {
        const before = details.getBoundingClientRect().height;
        details.querySelector('summary').click();
        // Pseudo-element transitions aren't listed by Element.getAnimations in Chromium.
        for (let index = 0; index < 8; index++) {
          await new Promise(requestAnimationFrame);
          const opacity = +getComputedStyle(details, '::details-content').opacity;
          if (opacity > 0 && opacity < 1 && details.getBoundingClientRect().height > before) return true;
        }
        return false;
      });
      assert.equal(menuMotion, true);
      if (settingsPreview) {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.vc-workbench-settings details[open]'),
          '::details-content').opacity === '1');
        await page.screenshot({ path: join(settingsPreview, 'settings-appearance.png'), animations: 'disabled' });
      }
      await settings.getByRole('button', { name: '梅紫', exact: true }).click();
      assert.equal(await accent.evaluate(node => node.open), false);
      assert.equal(await accent.locator('summary').evaluate(summary => document.activeElement === summary), true);
      await settings.getByRole('group', { name: '消息文字', exact: true }).getByRole('button', { name: '最大' }).click();
      await settings.getByRole('group', { name: '对话宽度', exact: true }).getByRole('button', { name: '宽屏' }).click();
      await expectToolTheme('codex', 'dark', '#d5afea');
      assert.equal(await composer.evaluate(node => getComputedStyle(node).fontSize), '18px');
      assert.equal(await workbench.locator('.vc-compose-wrap').evaluate(node => getComputedStyle(node).maxWidth), '960px');
      const closeAnimation = await settings.getByRole('button', { name: '完成', exact: true }).evaluate(async button => {
        const dialog = button.closest('dialog');
        button.click();
        await new Promise(requestAnimationFrame);
        return !dialog.open && dialog.getAnimations().some(animation => animation.transitionProperty === 'opacity');
      });
      assert.equal(closeAnimation, true);
      await settings.waitFor({ state: 'hidden' });
      assert.equal(await settingsButton.evaluate(button => document.activeElement === button), true);
      assert.equal(calls.length, callsBeforePreferences);

      await composer.fill('设置联测保留草稿');
      await openToolSettings();
      await tab('交互').click();
      await settings.getByRole('button', { name: 'Ctrl+Enter', exact: true }).click();
      await settings.getByRole('button', { name: '减少动画', exact: true }).click();
      assert.equal(await workbench.evaluate(root => getComputedStyle(root).getPropertyValue('--vc-popup-duration').trim()), '0ms');
      await tab('执行端').click();
      const codex = profile('codex');
      await codex.locator('summary').click();
      await codex.getByLabel('主题', { exact: true }).selectOption('light');
      await codex.getByLabel('强调色', { exact: true }).selectOption('blue');
      await codex.getByLabel('对话宽度', { exact: true }).selectOption('standard');
      await codex.getByRole('button', { name: '读取模型目录' }).click();
      await codex.getByLabel('模型', { exact: true }).selectOption('fixture-visual');
      await codex.getByLabel('推理强度', { exact: true }).selectOption('high');
      await expectToolTheme('codex', 'light', '#26619d');
      assert.equal(await workbench.locator('.vc-compose-wrap').evaluate(node => getComputedStyle(node).maxWidth), '728px');
      if (settingsPreview) {
        await codex.locator('summary').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(settingsPreview, 'settings-codex.png'), animations: 'disabled' });
      }

      const api = profile('claude');
      await api.locator('summary').click();
      assert.equal(await codex.locator('details').evaluate(node => node.open), false);
      failSettingsModels = true;
      await api.getByRole('button', { name: '读取模型目录', exact: true }).click();
      await api.getByRole('alert').waitFor();
      assert.equal(await chooser.getAttribute('data-provider'), 'codex');
      assert.equal(await composer.inputValue(), '设置联测保留草稿');
      failSettingsModels = false;
      const begin = calls.length;
      await api.getByRole('button', { name: '读取模型目录', exact: true }).click();
      await api.getByLabel('模型', { exact: true }).selectOption('sonnet');
      assert.deepEqual(calls.slice(begin).map(packet => [packet.op, packet.settings.provider, packet.targetId]), [
        ['list', 'claude', undefined], ['models', 'claude', settingsTargets.claude],
      ]);
      assert.equal(await api.getByLabel('推理强度', { exact: true }).count(), 0);
      const sdk = profile('claude-sdk');
      await sdk.locator('summary').click();
      await sdk.getByRole('button', { name: '读取模型目录', exact: true }).click();
      await sdk.getByLabel('模型', { exact: true }).selectOption('opus');
      assert.equal(calls.findLast(packet => packet.op === 'models').targetId, settingsTargets['claude-sdk']);
      const motionLess = calls.length;
      const antigravity = profile('antigravity');
      await antigravity.locator('summary').click();
      await antigravity.getByLabel('强调色', { exact: true }).selectOption('amber');
      assert.equal(await antigravity.getByRole('button', { name: '读取模型目录' }).count(), 0);
      const terminalProfile = profile('claude-subscription');
      await terminalProfile.locator('summary').click();
      assert.equal(await terminalProfile.getByRole('button', { name: '读取模型目录' }).count(), 0);
      await terminalProfile.getByLabel('主题', { exact: true }).selectOption('light');
      await terminalProfile.getByRole('button', { name: '重置此工具设置' }).click();
      assert.equal(await terminalProfile.locator('summary').evaluate(summary => document.activeElement === summary), true);
      assert.equal(calls.length, motionLess);
      await toolSetting('API 密钥').check();
      await toolSetting('Claude（订阅 SDK）').check();
      await toolSetting('Antigravity').check();
      await saveTools.click();
      await settings.waitFor({ state: 'hidden' });
      await page.reload();
      await page.getByText('settings-fixture · 已配置', { exact: true }).waitFor();
      await expectToolTheme('codex', 'light', '#26619d');
      assert.equal(await composer.evaluate(node => getComputedStyle(node).fontSize), '18px');
      const sendProfile = async (prompt, shortcut = false) => {
        await composer.fill(prompt);
        await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.op === 'send'),
          shortcut ? composer.press('Control+Enter') : send.click(),
        ]);
        await messages.locator('article').filter({ hasText: prompt }).getByText('设置测试已完成。', { exact: true }).waitFor();
        return calls.findLast(packet => packet.op === 'send');
      };
      await composer.fill('设置联测换行');
      const beforeEnter = calls.length;
      await composer.press('Enter');
      assert.equal(calls.length, beforeEnter);
      assert.ok((await composer.inputValue()).includes('\n'));
      const inherited = await sendProfile('设置联测工具默认模型', true);
      assert.equal(inherited.model, 'fixture-visual');
      assert.equal(inherited.effort, 'high');

      await modelControl.click();
      await modelName.click();
      assert.equal(await modelList.getByRole('radio', { name: '使用执行端默认', exact: true }).isChecked(), true);
      await modelList.getByRole('radio', { name: '测试快速模型', exact: true }).press('Space');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await modelPanel.waitFor({ state: 'hidden' });
      const overridden = await sendProfile('设置联测会话覆盖');
      assert.equal(overridden.model, 'fixture-fast');
      await modelControl.click();
      await modelName.click();
      await modelList.getByRole('radio', { name: '沿用会话设置', exact: true }).press('Space');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await modelPanel.waitFor({ state: 'hidden' });
      const automatic = await sendProfile('设置联测沿用会话');
      assert.equal(automatic.model, undefined);
      assert.equal(automatic.effort, undefined);
      await modelControl.click();
      await modelName.click();
      await modelList.getByRole('radio', { name: '使用执行端默认', exact: true }).press('Space');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await modelPanel.waitFor({ state: 'hidden' });
      const followed = await sendProfile('设置联测恢复执行端默认');
      assert.equal(followed.model, 'fixture-visual');
      assert.equal(followed.effort, 'high');

      await chooseTool('API 密钥');
      await expectToolTheme('claude', 'dark', '#d5afea');
      const claude = await sendProfile('设置联测 Claude 独立默认');
      assert.equal(claude.targetId, settingsTargets.claude);
      assert.equal(claude.model, 'sonnet');
      assert.equal(claude.effort, undefined);
      assert.equal(await workbench.getAttribute('data-theme-ripple'), null);
      await chooseTool('Claude（订阅 SDK）');
      const subscribed = await sendProfile('设置联测 Claude SDK 独立默认');
      assert.equal(subscribed.targetId, settingsTargets['claude-sdk']);
      assert.equal(subscribed.model, 'opus');
      assert.equal(subscribed.effort, undefined);
      await chooseTool('Antigravity');
      await expectToolTheme('antigravity', 'dark', '#efbd91');
      await page.setViewportSize({ width: 350, height: 640 });
      await openToolSettings();
      await tab('外观').click();
      const dimensions = await settings.evaluate(dialog => ({
        dialog: dialog.getBoundingClientRect().width,
        viewport: window.innerWidth,
        navigation: getComputedStyle(dialog.querySelector('nav')).display,
        scrollWidth: dialog.querySelector('.vc-settings-scroll').scrollWidth,
        available: dialog.querySelector('.vc-settings-scroll').clientWidth,
      }));
      assert.ok(dimensions.dialog < dimensions.viewport && dimensions.scrollWidth <= dimensions.available + 1, JSON.stringify(dimensions));
      assert.equal(dimensions.navigation, 'grid');
      if (settingsPreview) await page.screenshot({ path: join(settingsPreview, 'settings-narrow.png'), animations: 'disabled' });
      await settings.getByRole('button', { name: '恢复默认', exact: true }).click();
      await tab('交互').click();
      await settings.getByRole('button', { name: '恢复默认', exact: true }).click();
      await settings.getByRole('button', { name: '完成', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1272, height: 822 });
    });

    await t.test('account settings route all tools through the authenticated pinned VPS viewer', async () => {
      saved.clear();
      targetId = 'b'.repeat(64);
      preset = { name: 'accounts-fixture', settings: { ...preset.settings, host: 'accounts-fixture.invalid', provider: 'codex' },
        targetId, sessions: [] };
      const accountPackets = [];
      let startupReason;
      const intercept = async route => {
        const request = route.request();
        if (request.method() !== 'POST' || request.postDataJSON()?.op !== 'account-view') return route.fallback();
        accountPackets.push(request.postDataJSON());
        assert.equal(new URL(request.url()).origin, origin);
        assert.match(await request.headerValue('x-dsh-vps-chat-token'), /^[\w-]{43}$/);
        await route.fulfill({ json: { ok: true, protocol: 'dsh-account.' + 'a'.repeat(43), port } });
      };
      const fakePlayer = route => route.fulfill({ contentType: 'text/javascript', body: `
        export default class Viewer extends EventTarget {
          constructor(screen, socket) {
            super();
            (window.fixtureAccountConnections ??= []).push({ url: socket.url });
            socket.addEventListener('open', () => {
              screen.textContent = '隔离的 VPS 账号画面';
              this.dispatchEvent(new Event('connect'));
            });
            socket.addEventListener('close', () => this.dispatchEvent(new Event('disconnect')));
          }
          disconnect() { window.fixtureAccountDisconnects = (window.fixtureAccountDisconnects ?? 0) + 1; }
        }
      ` });
      const rpcUrl = origin + '/dsh-vps-chat/api/rpc';
      const playerUrl = origin + '/dsh-vps-chat/api/account-player.mjs';
      await page.route(rpcUrl, intercept);
      await page.route(playerUrl, fakePlayer);
      await page.routeWebSocket(`ws://127.0.0.1:${port}/dsh-vps-chat/api/account-screen`, socket => {
        if (startupReason) socket.close({ code: 1011, reason: startupReason });
      });
      try {
        await page.reload();
        await page.getByText('accounts-fixture · 已配置', { exact: true }).waitFor();
        await openToolSettings();
        await toolSetting('API 密钥').check();
        await saveTools.click();
        await settings.waitFor({ state: 'hidden' });
        await chooseTool('API 密钥');
        await workbench.locator('.vc-tool-trigger[data-provider=claude]').waitFor();
        await openToolSettings();
        await settings.getByRole('navigation').getByRole('button', { name: '账号', exact: true }).click();
        const pane = settings.getByRole('region', { name: '账号管理', exact: true });
        assert.equal(accountPackets.length, 0);
        const actions = [
          ['ChatGPT 账号', '管理 ChatGPT 账号', 'chatgpt-account'],
          ['VPS 登录 Codex', 'Codex CLI 登录', 'codex-login'],
          ['Claude 账号', '管理 Claude 账号', 'claude-account'],
          ['VPS 登录 Claude', 'Claude Code 订阅登录', 'claude-login'],
          ['API 密钥控制台', '管理 Claude API 密钥', 'claude-console'],
          ['设置 VPS 密钥', '设置 VPS 上的 Claude API 密钥', 'claude-api-key'],
          ['Google 账号', '管理 Google 账号', 'google-account'],
          ['VPS 登录 Antigravity', 'Antigravity CLI 登录', 'antigravity-login'],
        ];
        if (accountsPreview) await page.screenshot({ path: join(accountsPreview, 'settings-accounts.png'), animations: 'disabled' });
        for (const [label, title, action] of actions) {
          const button = pane.getByRole('button', { name: label, exact: true });
          await button.click();
          const viewer = page.getByRole('dialog', { name: title, exact: true });
          await viewer.getByText('隔离的 VPS 账号画面').waitFor();
          assert.deepEqual(accountPackets.at(-1), { op: 'account-view', targetId, action });
          await viewer.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
          await viewer.waitFor({ state: 'hidden' });
          assert.equal(await button.evaluate(node => node === document.activeElement), true);
        }
        const relays = await page.evaluate(() => ({
          connections: window.fixtureAccountConnections.map(item => item.url),
          disconnects: window.fixtureAccountDisconnects,
        }));
        assert.equal(relays.connections.length, actions.length);
        assert.equal(relays.disconnects, actions.length);
        assert.ok(relays.connections.every(url => url === `ws://127.0.0.1:${port}/dsh-vps-chat/api/account-screen`));
        startupReason = 'account_encrypted_home_required';
        await pane.getByRole('button', { name: 'VPS 登录 Claude', exact: true }).click();
        const blocked = page.getByRole('dialog', { name: 'Claude Code 订阅登录', exact: true });
        await blocked.getByRole('status').getByText('执行端登录与密钥保存需要当前 VPS 用户的加密家目录。').waitFor();
        await blocked.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
        await blocked.waitFor({ state: 'hidden' });
        startupReason = undefined;
        const offerCount = accountPackets.length;
        preset = { ...preset, settings: { ...preset.settings, host: 'different-fixture.invalid' } };
        await pane.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click();
        const denied = page.getByRole('dialog', { name: '管理 ChatGPT 账号', exact: true });
        await denied.getByText('请切回已核对指纹的默认 VPS，再打开账号窗口。').waitFor();
        assert.equal(accountPackets.length, offerCount);
        await page.keyboard.press('Escape');
        await denied.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 350, height: 660 });
        if (accountsPreview) await page.screenshot({ path: join(accountsPreview, 'settings-accounts-narrow.png'), animations: 'disabled' });
        const widths = await pane.evaluate(node => ({ actual: node.scrollWidth, available: node.clientWidth }));
        assert.ok(widths.actual <= widths.available + 1, JSON.stringify(widths));
        await settings.getByRole('button', { name: '完成', exact: true }).click();
        await settings.waitFor({ state: 'hidden' });
      } finally {
        await page.unroute(rpcUrl, intercept);
        await page.unroute(playerUrl, fakePlayer);
        await page.setViewportSize({ width: 1272, height: 822 });
      }
    });

    await t.test('subscription switch owns a native Claude terminal while retaining the chat draft', async () => {
      targetId = '8'.repeat(64);
      saved.clear();
      preset = { name:'native-fixture', settings:{...preset.settings, host:'native-fixture.invalid', provider:'codex'}, targetId, sessions:[] };
      await page.reload();
      await chooser.waitFor();
      await openToolSettings();
      await toolSetting('Claude Code（订阅终端）').check();
      await saveTools.click();
      await composer.fill('切回后继续这条草稿');
      const before = calls.length;
      await chooseTool('Claude Code（订阅终端）');
      const terminal = page.getByRole('region', {name:'Claude Code 订阅终端'});
      await terminal.waitFor();
      await expectToolTheme('claude-subscription', 'light', '#82541d');
      await expectToolIcon(chooser, 'claude-code', 48);
      await setDesktopDark(true);
      await expectToolTheme('claude-subscription', 'dark', '#eac084');
      await setDesktopDark(false);
      if (toolsPreview) await page.screenshot({path:join(toolsPreview,'claude-terminal-light.png'),animations:'disabled'});
      const nativeComposer = terminal.getByRole('textbox', {name:'Claude Code 消息'});
      const send = terminal.getByRole('button', {name:'发送消息'});
      const interrupt = terminal.getByRole('button', {name:'中断当前操作'});
      const inputPackets = () => nativeCalls.filter(packet => packet.op === 'native-input');
      await terminal.getByRole('heading', {name:'开始一段对话'}).waitFor();
      for (const width of [1272, 800, 390]) {
        await page.setViewportSize({width, height:width === 390 ? 540 : 822});
        const layout = await page.evaluate(() => {
          const frame = document.querySelector('[data-vps-chat]');
          const pane = frame.querySelector('[aria-label="VPS 订阅会话"]');
          const composer = pane.querySelector('.vc-composer');
          const box = composer.getBoundingClientRect();
          return {
            frame: frame.clientWidth,
            main: frame.querySelector('.vc-main').getBoundingClientRect().width,
            pane: pane.getBoundingClientRect().width,
            railHidden: getComputedStyle(frame.querySelector('.vc-rail')).display === 'none',
            editorVisible: box.top > 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
            sameComposer: getComputedStyle(composer).backgroundColor ===
              getComputedStyle(frame.querySelector('.vc-main-body .vc-composer')).backgroundColor,
          };
        });
        assert.ok(layout.railHidden && layout.editorVisible && layout.sameComposer && Math.abs(layout.frame - layout.main) < 2 &&
          Math.abs(layout.frame - layout.pane) < 2, JSON.stringify({ width, ...layout }));
      }
      await page.setViewportSize({width:1272,height:822});
      assert.equal(await composer.isVisible(), false);
      assert.equal(nativeCalls.length, 0);
      assert.equal(calls.length, before);

      const start = terminal.getByRole('button', {name:'继续会话'});
      await nativeComposer.fill('订阅模式草稿');
      await nativeComposer.press('Enter');
      assert.equal(await send.isDisabled(),true);
      holdSubscriptionBootstrap = true;
      try {
        await Promise.all([
          page.waitForRequest(request => request.url().endsWith('/dsh-terminal-workbench/api/bootstrap')),
          start.click(),
        ]);
        await chooseTool('Codex');
        await composer.waitFor();
        await chooseTool('Claude Code（订阅终端）');
      } finally {
        holdSubscriptionBootstrap = false;
        releaseSubscriptionBootstrap?.();
        releaseSubscriptionBootstrap = undefined;
      }
      targetId = 'b'.repeat(64);
      await start.click();
      await terminal.getByRole('alert').getByText('未启动终端。请核对 VPS 主机指纹和 SSH 中继配置。').waitFor();
      assert.equal(nativeCalls.filter(packet => packet.op === 'native-subscription-start').length,1);
      assert.equal(nativeLaunches.length, 0);
      targetId = preset.targetId;
      await start.click();
      await terminal.getByText('隔离终端运行中', {exact:true}).waitFor();
      assert.equal(nativeLaunches.length, 1);
      assert.equal(nativeLaunches[0].mode, 'picker');
      assert.equal(nativeLaunches[0].settings.hostKeyConfirmed, true);
      assert.equal(nativeLaunches[0].settings.provider, 'codex');
      assert.equal(await nativeComposer.inputValue(),'订阅模式草稿');
      assert.equal(inputPackets().length,0);

      await nativeComposer.dispatchEvent('compositionstart', {data:'草稿'});
      await nativeComposer.dispatchEvent('keydown', {key:'Enter',code:'Enter',isComposing:true});
      await nativeComposer.dispatchEvent('compositionend', {data:'草稿'});
      assert.equal(inputPackets().length,0);
      await send.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Claude Code 消息"]').value === '');
      assert.equal(await nativeComposer.evaluate(field => document.activeElement === field),true);
      assert.deepEqual(inputPackets().map(packet => Buffer.from(packet.data,'base64').toString()), ['订阅模式草稿\r']);

      await nativeComposer.fill('第一行');
      await nativeComposer.press('End');
      await nativeComposer.press('Shift+Enter');
      await page.keyboard.insertText('第二行');
      assert.equal(await nativeComposer.inputValue(),'第一行\n第二行');
      await nativeComposer.press('Enter');
      await terminal.getByRole('alert').getByText('当前终端未启用多行粘贴，请先发送单行消息。').waitFor();
      assert.equal(inputPackets().length,1);
      nativeEvents.push({type:'output',sequence:1,data:Buffer.from('\x1b[?2004hCOPY-FIXTURE').toString('base64')});
      const output = terminal.locator('.xterm-rows').getByText('COPY-FIXTURE',{exact:false});
      await output.waitFor();
      await nativeComposer.press('Enter');
      await page.waitForFunction(() => document.querySelector('[aria-label="Claude Code 消息"]').value === '');
      assert.deepEqual(inputPackets().map(packet => Buffer.from(packet.data,'base64').toString()), [
        '订阅模式草稿\r', '\x1b[200~第一行\r第二行\x1b[201~\r',
      ]);
      assert.ok(inputPackets().every(packet => packet.sessionId === nativeId));
      await nativeComposer.fill('切换执行端后保留订阅草稿');
      await page.setViewportSize({width:390,height:540});
      const sendBounds = await send.boundingBox();
      assert.ok(sendBounds && sendBounds.x >= 0 && sendBounds.x + sendBounds.width <= 390 &&
        sendBounds.y > 0 && sendBounds.y + sendBounds.height <= 540);
      await page.setViewportSize({width:1272,height:822});

      await chooseTool('Codex');
      await composer.waitFor();
      assert.equal(await composer.inputValue(), '切回后继续这条草稿');
      await page.getByRole('navigation', {name:'会话记录'}).waitFor();
      const railWidth = await page.locator('.vc-rail').evaluate(rail => rail.getBoundingClientRect().width);
      assert.equal(railWidth,216);
      await chooseTool('Claude Code（订阅终端）');
      await terminal.getByText('隔离终端运行中', {exact:true}).waitFor();
      assert.equal(nativeLaunches.length,1);
      assert.equal(await nativeComposer.inputValue(),'切换执行端后保留订阅草稿');

      const escape = '\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_';
      await interrupt.click();
      await terminal.getByText('已发送 Esc',{exact:false}).waitFor();
      assert.equal(Buffer.from(inputPackets().at(-1).data,'base64').toString(),escape);
      await nativeComposer.dispatchEvent('keydown',{key:'Escape',code:'Escape',repeat:true});
      await nativeComposer.dispatchEvent('keydown',{key:'Escape',code:'Escape',isComposing:true});
      assert.equal(inputPackets().length,3);
      await Promise.all([
        page.waitForResponse(response => response.request().postDataJSON()?.op === 'native-input'),
        nativeComposer.press('Escape'),
      ]);
      assert.equal(Buffer.from(inputPackets().at(-1).data,'base64').toString(),escape);
      assert.equal(inputPackets().length,4);
      assert.equal(await nativeComposer.inputValue(),'切换执行端后保留订阅草稿');
      assert.equal(nativeCalls.some(packet => packet.op === 'native-close'),false);

      await terminal.getByRole('button',{name:'聚焦终端'}).click();
      const nativeScreen = terminal.locator('.xterm-helper-textarea');
      assert.equal(await nativeScreen.evaluate(field => document.activeElement === field),true);
      const surface = await terminal.locator('.xterm-screen').boundingBox();
      const row = await output.boundingBox();
      const cell = surface.width / 80;
      const y = row.y + row.height / 2;
      await page.mouse.move(surface.x + cell / 4,y);
      await page.mouse.down();
      await page.mouse.move(surface.x + cell * 12.2,y,{steps:5});
      await page.mouse.up();
      await terminal.getByRole('button',{name:'复制选中输出'}).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()),'COPY-FIXTURE');
      await terminal.getByText('已复制选中输出',{exact:false}).waitFor();
      assert.equal(inputPackets().length,4);

      rejectNextNativeInput = true;
      await interrupt.click();
      await terminal.getByRole('alert').getByText('输入结果未确认', {exact:false}).waitFor();
      assert.equal(await send.isDisabled(),true);
      assert.equal(await interrupt.isDisabled(),true);
      assert.equal(await nativeComposer.inputValue(),'切换执行端后保留订阅草稿');
      await nativeComposer.press('Escape');
      await nativeComposer.press('Enter');
      assert.equal(inputPackets().length,5);
      assert.ok(inputPackets().every(packet => packet.sessionId === nativeId));
      await page.evaluate(() => window.fixtureShowNative());
      const standalone = page.getByRole('region', {name:'远端原生终端工作台'});
      await standalone.getByRole('button',{name:'查询当前连接'}).click();
      await standalone.getByRole('alert').getByText('另一个工作台正在使用远端终端。请切回该工作台查看或关闭。').waitFor();
      assert.equal(nativeCalls.some(packet => packet.op === 'native-current'), false);
      assert.equal(calls.slice(before).some(packet => packet.op !== 'list'), false);
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
  }
});
