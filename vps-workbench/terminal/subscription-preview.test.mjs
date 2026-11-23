import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPreview } from '../desktop/preview-server.mjs';
import { openSettingsSection } from '../desktop/test-settings.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const sessionId = 'a240be63-743c-4017-adc1-1a91c6c8d193';
const terminalPath = '/dsh-terminal-workbench/api/rpc';
const terminalLabel = 'Claude Code 订阅终端';
const subscriptionLabel = 'Claude Code（订阅终端）';

async function openTerminalPreview(t, { width = 1280, height = 720, reducedMotion = 'reduce', enter = true } = {}) {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const browser = await chromium.launch({ channel: 'msedge', args: ['--disable-background-networking', '--no-proxy-server'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(preview.origin + '/') || url.startsWith(`blob:${preview.origin}/`) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  page.setDefaultTimeout(8000);

  let state = 'idle';
  let measuredStart;
  let transformPoll;
  const calls = [], events = [];
  function append(bytes, type = 'output') {
    const sequence = events.length + 1;
    if (type === 'output') {
      const data = Buffer.from(bytes);
      assert.ok(data.length > 0 && data.length <= 4096);
      events.push({ sequence, type, data: data.toString('base64') });
    } else events.push({ sequence, type });
    return sequence;
  }
  await page.route('**' + terminalPath, async (route) => {
    const packet = route.request().postDataJSON();
    calls.push(packet);
    const respond = (result, headers) => route.fulfill({ json: { ok: true, result }, headers });
    switch (packet.op) {
      case 'native-subscription-start':
        assert.equal(state, 'idle');
        state = 'ready';
        append('\x1b[?2004hClaude Code · 本地演示\r\n\r\n❯ ');
        return respond({ sessionId, state });
      case 'native-poll': {
        assert.equal(packet.sessionId, sessionId);
        assert.ok(Number.isSafeInteger(packet.after) && packet.after >= 0 && packet.after <= events.length);
        const batch = events.slice(packet.after, packet.after + 64);
        const start = batch.some(({ sequence }) => sequence === measuredStart);
        const reply = { sessionId, state, lastSequence: events.length, acknowledged: packet.after, gap: false, events: batch };
        const modify = transformPoll;
        transformPoll = undefined;
        return respond(modify ? await modify(reply) : reply, start ? { 'x-fixture-burst': 'start' } : undefined);
      }
      case 'native-resize':
      case 'native-input':
        assert.equal(packet.sessionId, sessionId);
        return respond({ sessionId, state, lastSequence: events.length });
      case 'native-close':
        assert.equal(packet.sessionId, sessionId);
        append('\r\nFIXTURE-EXIT\r\n');
        append('', 'exit');
        state = 'closed';
        return respond({ sessionId, state });
      case 'native-subscription-current':
        return respond({ sessionId, state, gap: false,
          acknowledged: calls.findLast(({ op }) => op === 'native-poll')?.after ?? 0 });
      default:
        throw new Error(`Unexpected terminal fixture operation: ${packet.op}`);
    }
  });
  await page.addInitScript(() => {
    const before = window.fetch;
    window.fetch = async (...args) => {
      const response = await before(...args);
      const sample = window.terminalSample;
      if (response.headers.get('x-fixture-burst') !== 'start' || !sample || sample.started) return response;
      sample.started = performance.now();
      const intervals = [];
      let previous;
      function frame(now) {
        if (window.terminalSample !== sample) return;
        if (previous !== undefined) intervals.push(now - previous);
        previous = now;
        const elapsed = performance.now() - sample.started;
        if (sample.visibleMs === undefined &&
            document.querySelector('.ntw-screen .xterm-rows')?.textContent.includes(sample.marker)) sample.visibleMs = elapsed;
        if (sample.visibleMs !== undefined && elapsed > sample.visibleMs + 250 || elapsed > 7000) {
          sample.intervals = intervals;
          sample.done = true;
          return;
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      return response;
    };
  });
  await page.goto(preview.origin);
  await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
  async function choose(name) {
    await page.getByRole('button', { name: '切换 VPS 执行端', exact: true })
      .and(page.locator('[aria-disabled=false]')).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  const terminal = page.getByRole('region', { name: terminalLabel, exact: true });
  if (enter) {
    await choose(subscriptionLabel);
    await terminal.waitFor();
  }
  const after = (sequence) => page.waitForRequest((request) => {
    if (!request.url().endsWith(terminalPath) || request.method() !== 'POST') return false;
    const packet = request.postDataJSON();
    return packet?.op === 'native-poll' && packet.sessionId === sessionId && packet.after === sequence;
  });
  async function start() {
    await terminal.getByRole('button', { name: '新对话', exact: true }).click();
    await terminal.getByText('隔离终端运行中', { exact: true }).waitFor();
    await terminal.locator('.xterm-rows').getByText('Claude Code · 本地演示', { exact: true }).waitFor();
  }
  return { page, terminal, browser, calls, events, append, after, start, choose,
    changeNextPoll(change) { transformPoll = change; },
    measureNext() { measuredStart = events.length + 1; } };
}

function burstBytes(marker) {
  const lines = Array.from({ length: 511 }, (_, index) =>
    `line ${String(index + 1).padStart(3, '0')}  terminal audit · 流式输出 `);
  const tail = `\x1b[32m${marker}\x1b[0m ❯ `;
  const remaining = 34260 - Buffer.byteLength(lines.join('\r\n') + '\r\n' + tail);
  const padding = Math.floor(remaining / lines.length);
  const extra = remaining % lines.length;
  return Buffer.from(lines.map((line, index) => line + 'x'.repeat(padding + Number(index < extra))).join('\r\n') + '\r\n' + tail);
}

function frameStats(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (fraction) => Number(sorted[Math.ceil(sorted.length * fraction) - 1]?.toFixed(1));
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1), over33: sorted.filter((ms) => ms > 33).length };
}

test('subscription terminal keeps the sidebar and can return through history without closing the terminal', { timeout: 35_000 }, async (t) => {
  const fixture = await openTerminalPreview(t, { enter: false });
  const { page, terminal, calls } = fixture;
  const compact = page.getByRole('navigation', { name: '快捷侧栏', exact: true });
  const history = page.getByRole('complementary', { name: 'VPS 对话列表', exact: true });
  const dockToggle = compact.getByRole('button', { name: '会话与项目', exact: true });
  await dockToggle.click();
  await history.waitFor();
  await fixture.choose(subscriptionLabel);
  await terminal.waitFor();
  await compact.waitFor();
  await history.waitFor();
  const [panel, surface] = await Promise.all([history.boundingBox(), terminal.boundingBox()]);
  assert.ok(panel.x + panel.width <= surface.x);
  await fixture.start();
  await dockToggle.click();
  await history.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click();
  await history.getByRole('button', { name: '周末读书会', exact: true }).click();
  await history.getByRole('button', { name: '读书会 · 开场流程', exact: true }).click();
  await terminal.waitFor({ state: 'hidden' });
  await page.getByText(/先留五分钟签到/u).first().waitFor();
  await fixture.choose(subscriptionLabel);
  await terminal.locator('.xterm-rows').getByText('Claude Code · 本地演示', { exact: true }).waitFor();
  assert.equal(calls.filter(({ op }) => op === 'native-subscription-start').length, 1);
  assert.equal(calls.some(({ op }) => op === 'native-close'), false);

  await page.setViewportSize({ width: 365, height: 480 });
  await history.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click();
  await history.getByRole('button', { name: '新建对话', exact: true }).waitFor();
  await page.getByRole('button', { name: '收起会话侧栏', exact: true }).click();
  await history.waitFor({ state: 'hidden' });
  await fixture.choose('Codex');
  await terminal.waitFor({ state: 'hidden' });
  await page.getByText(/先留五分钟签到/u).first().waitFor();
});

test('subscription terminal burst benchmark measures the tail and confirms the receipt', { timeout: 45_000 }, async (t) => {
  const fixture = await openTerminalPreview(t);
  const { page, calls, events, terminal } = fixture;
  await fixture.start();
  await fixture.after(1);
  const samples = [];
  for (let sample = 1; sample <= 3; sample++) {
    for (const count of [128, 10]) {
      const marker = `BURST-${count}-${sample}-TAIL`;
      const bytes = burstBytes(marker);
      assert.equal(bytes.length, 34260);
      const before = events.length;
      const confirmed = fixture.after(before + count);
      await page.evaluate((marker) => { window.terminalSample = { marker }; }, marker);
      fixture.measureNext();
      for (let index = 0; index < count; index++) {
        fixture.append(bytes.subarray(Math.floor(index * bytes.length / count), Math.floor((index + 1) * bytes.length / count)));
      }
      await Promise.all([confirmed, page.waitForFunction(() => window.terminalSample?.done)]);
      const result = await page.evaluate(() => window.terminalSample);
      assert.ok(Number.isFinite(result.visibleMs), marker);
      const actualPolls = calls.filter(({ op, after }) => op === 'native-poll' && after > before && after <= before + count)
        .map(({ after }) => after - before);
      assert.ok(actualPolls.includes(count));
      assert.ok(actualPolls.every((value) => value === Math.min(count, 64) || value === count));
      const tail = await terminal.locator('.xterm-rows').innerText();
      assert.ok(tail.indexOf('line 509') < tail.indexOf(marker) && tail.includes('line 511') && tail.includes(marker));
      assert.equal(tail.includes('\uFFFD'), false);
      samples.push({ count, sample, bytes: bytes.length, visibleMs: Number(result.visibleMs.toFixed(1)), frames: frameStats(result.intervals) });
    }
  }
  t.diagnostic(JSON.stringify({ viewport: [1280, 720], browser: fixture.browser.version(), samples }));
});

for (const [width, height] of [[365, 480], [420, 640], [1280, 720]]) {
  test(`subscription terminal fits and retains the history viewport at ${width}×${height}`, { timeout: 30_000 }, async (t) => {
    const fixture = await openTerminalPreview(t, { width, height });
    const { page, terminal, append, after, calls, events } = fixture;
    const resized = page.waitForRequest((request) => request.url().endsWith(terminalPath) &&
      request.method() === 'POST' && request.postDataJSON()?.op === 'native-resize');
    await Promise.all([fixture.start(), resized]);
    const size = (await resized).postDataJSON();
    assert.ok(size.columns >= 32 && size.rows >= 4, JSON.stringify(size));
    await page.waitForFunction(({ rows }) => document.querySelector('.ntw-screen .xterm-rows')?.childElementCount === rows, size);

    const before = events.length;
    const tail = 'FIT-TAIL';
    const receipt = after(before + 65);
    const line = (number) => `History ${String(number).padStart(3, '0')}  terminal audit output 012345678901234567\r\n`;
    for (let index = 1; index <= 62; index++) append(line(index));
    append('\x1b[');
    const utf8 = Buffer.from('尾行🌿 ' + tail);
    append(Buffer.concat([Buffer.from('32m'), utf8.subarray(0, 2)]));
    append(Buffer.concat([utf8.subarray(2), Buffer.from('\x1b[0m\r\n❯ ')]));
    await receipt;
    const screen = terminal.locator('.ntw-screen');
    await terminal.getByRole('button', { name: '聚焦终端', exact: true }).click();
    const fitted = await screen.evaluate((card, marker) => {
      const outer = card.closest('.vc-scroll');
      const mount = card.querySelector('.ntw-terminal').getBoundingClientRect();
      const rows = Array.from(card.querySelectorAll('.xterm-rows > div'));
      const row = rows.find((line) => line.textContent.includes(marker));
      const cursor = card.querySelector('.xterm-cursor');
      const within = (element, box) => {
        const r = element?.getBoundingClientRect();
        return Boolean(r && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.right <= box.right + 1);
      };
      return { tail: row?.textContent, tailVisible: within(row, mount) && within(row, outer.getBoundingClientRect()),
        cursorVisible: within(cursor, mount) && cursor.closest('.xterm-rows')?.textContent.includes('❯'),
        cardX: card.scrollWidth - card.clientWidth, outerY: outer.scrollHeight - outer.clientHeight,
        screenWidth: card.querySelector('.xterm-screen').offsetWidth,
        cardWidth: card.clientWidth, rowCount: rows.length };
    }, tail);
    assert.ok(fitted.tail?.includes('尾行🌿 ' + tail), JSON.stringify(fitted));
    assert.ok(fitted.tailVisible && fitted.cursorVisible, JSON.stringify(fitted));
    assert.ok(fitted.cardX <= 1 && fitted.outerY <= 1, JSON.stringify(fitted));
    for (const control of [terminal.getByRole('textbox', { name: 'Claude Code 消息' }),
      terminal.getByRole('button', { name: '聚焦终端' }), terminal.getByText('隔离终端运行中', { exact: true })]) {
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
        bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, JSON.stringify(bounds));
    }
    assert.ok(calls.some(({ op, after }) => op === 'native-poll' && after === before + 64));
    if (process.env.VPS_WORKBENCH_TERMINAL_PREVIEW_DIR) {
      await page.screenshot({ path: join(process.env.VPS_WORKBENCH_TERMINAL_PREVIEW_DIR, `terminal-${width}x${height}.png`) });
    }

    await screen.hover();
    await page.mouse.wheel(0, -260);
    await page.waitForFunction((marker) => !document.querySelector('.ntw-screen .xterm-rows')?.textContent.includes(marker), tail);
    const firstRow = screen.locator('.xterm-rows > div').first();
    const first = await firstRow.innerText();
    const appended = after(events.length + 1);
    append('\r\nAPPENDED-LIVE-TAIL\r\n❯ ');
    await appended;
    assert.equal(await firstRow.innerText(), first);
    assert.equal(await screen.getByText('APPENDED-LIVE-TAIL', { exact: true }).count(), 0);
    await screen.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, 900);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.wheel(0, 180);
    try {
      await page.waitForFunction(() => document.querySelector('.ntw-screen .xterm-rows')?.textContent.includes('APPENDED-LIVE-TAIL'));
    } catch (error) {
      t.diagnostic(await screen.locator('.xterm-rows').innerText());
      throw error;
    }
    t.diagnostic(JSON.stringify({ width, height, columns: size.columns, rows: size.rows, ...fitted }));

    if (width === 420) {
      await terminal.getByText('会话连接与回执', { exact: true }).click();
      const final = after(events.length + 2);
      await terminal.getByRole('button', { name: '关闭终端', exact: true }).click();
      await final;
      await terminal.getByText('本机终端已关闭', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.ntw-screen .xterm-rows')?.textContent.includes('FIXTURE-EXIT'));
    }
  });
}

test('subscription terminal leaves a malformed or mismatched page unacknowledged and reads the original on request',
  { timeout: 30_000 }, async (t) => {
    const fixture = await openTerminalPreview(t);
    const { calls, events, terminal } = fixture;
    await fixture.start();
    await fixture.after(1);
    fixture.changeNextPoll((reply) => ({
      ...reply, events: [reply.events[0], { ...reply.events[1], sequence: reply.lastSequence + 1 }],
    }));
    fixture.append('\r\nORIGINAL-FIRST\r\n');
    fixture.append('ORIGINAL-LAST\r\n❯ ');
    await terminal.getByRole('alert').filter({ hasText: '终端输出或连接状态未确认' }).waitFor();
    assert.equal(calls.findLast(({ op }) => op === 'native-poll').after, 1);
    assert.equal(await terminal.getByText('ORIGINAL-FIRST', { exact: true }).count(), 0);
    assert.equal(calls.filter(({ op }) => op === 'native-input').length, 0);
    const confirmed = fixture.after(events.length);
    await terminal.getByRole('button', { name: '查询当前连接', exact: true }).click();
    await confirmed;
    assert.equal(await terminal.getByText('ORIGINAL-FIRST', { exact: true }).count(), 1);
    assert.equal(await terminal.getByText('ORIGINAL-LAST', { exact: true }).count(), 1);

    fixture.changeNextPoll((reply) => ({ ...reply, sessionId: 'different-session' }));
    fixture.append('\r\nMISMATCHED-TAIL');
    await terminal.getByRole('alert').filter({ hasText: '终端输出或连接状态未确认' }).waitFor();
    assert.equal(calls.findLast(({ op }) => op === 'native-poll').after, events.length - 1);
    assert.equal(await terminal.getByText('MISMATCHED-TAIL', { exact: true }).count(), 0);
    assert.equal(calls.filter(({ op }) => op === 'native-subscription-start').length, 1);
  });

test('subscription entry and exit use the same brief arrival and preserve focus and session while resizing',
  { timeout: 35_000 }, async (t) => {
    const fixture = await openTerminalPreview(t, { reducedMotion: 'no-preference', enter: false });
    const { page, terminal, choose, calls, events } = fixture;
    const selector = '[data-vps-chat][data-subscription-open]';
    const picker = page.getByRole('button', { name: '切换 VPS 执行端', exact: true });
    const draft = page.getByRole('textbox', { name: '消息', exact: true });
    await draft.fill('切换前的 Codex 草稿');
    const samples = [];

    async function switchView(name, entering, resize) {
      const motion = page.evaluate(({ selector, entering }) => new Promise((resolve) => {
        const deadline = performance.now() + 2500;
        let first;
        let snapshot;
        function sample(now) {
          const root = document.querySelector(selector);
          const main = root.querySelector(':scope > .vc-main');
          const animation = main.getAnimations({ subtree: true }).find(({ id }) => id === 'vc-subscription-arrival');
          if (root.dataset.subscriptionOpen === String(entering) && animation && first === undefined) {
            first = now;
            const content = main.getBoundingClientRect();
            const dock = root.querySelector('.vc-sidebar-actions').getBoundingClientRect();
            snapshot = {
              duration: animation.effect.getTiming().duration,
              from: animation.effect.getKeyframes()[0].transform,
              oldRipple: root.hasAttribute('data-theme-ripple'),
              menuVisible: getComputedStyle(root.querySelector('.vc-tool-palette')).display !== 'none',
              mainOverlapsDock: content.left < dock.right - 1 && content.right > dock.left + 1 &&
                content.bottom > dock.top + 1 && content.top < dock.bottom - 1,
              chatVisible: main.querySelector('.vc-main-body').getClientRects().length > 0,
              terminalVisible: main.querySelector('[aria-label="VPS 订阅会话"]').getClientRects().length > 0,
            };
          } else if (first !== undefined && !animation) {
            resolve({ ...snapshot, elapsedMs: Number((now - first).toFixed(1)) });
            return;
          }
          if (now > deadline) { resolve(null); return; }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }), { selector, entering });
      await choose(name);
      if (resize) {
        await page.locator('[data-subscription-transition]').waitFor();
        await page.setViewportSize(resize);
      }
      const result = await motion;
      assert.ok(result, name);
      assert.equal(result.duration, 240);
      assert.equal(result.from, 'translateY(6px)');
      assert.equal(result.oldRipple, false);
      assert.equal(result.menuVisible, false);
      assert.equal(result.mainOverlapsDock, false);
      assert.equal(result.chatVisible, !entering);
      assert.equal(result.terminalVisible, entering);
      assert.equal(await picker.evaluate((button) => button === document.activeElement), true);
      samples.push({ entering, ...result, resized: Boolean(resize) });
    }

    await switchView(subscriptionLabel, true);
    await fixture.start();
    await fixture.after(1);
    await switchView('Codex', false, { width: 420, height: 640 });
    assert.equal(await draft.inputValue(), '切换前的 Codex 草稿');
    const observed = fixture.after(events.length + 1);
    fixture.append('\r\nHIDDEN-SESSION-OUTPUT\r\n❯ ');
    await observed;
    await switchView(subscriptionLabel, true);
    await terminal.getByText('隔离终端运行中', { exact: true }).waitFor();
    assert.ok((await terminal.locator('.xterm-rows').innerText()).includes('HIDDEN-SESSION-OUTPUT'));
    assert.equal(calls.filter(({ op }) => op === 'native-subscription-start').length, 1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [name, entering] of [['Codex', false], [subscriptionLabel, true]]) {
      await choose(name);
      await page.locator(`${selector}[data-subscription-open=${entering}]`).waitFor();
      assert.equal(await page.locator('[data-subscription-transition], [data-theme-ripple]').count(), 0);
      assert.equal(await picker.evaluate((button) => button === document.activeElement), true);
    }
    t.diagnostic(JSON.stringify(samples));
  });

test('the subscription cursor follows system and effective app motion settings on the running terminal',
  { timeout: 30_000 }, async (t) => {
    const fixture = await openTerminalPreview(t, { reducedMotion: 'no-preference' });
    const { page, terminal, calls, events } = fixture;
    await fixture.start();
    const marker = fixture.after(events.length + 1);
    fixture.append('\x1b[?25h\x1b[1 q');
    await marker;
    const focus = terminal.getByRole('button', { name: '聚焦终端', exact: true });
    const terminalInput = terminal.locator('.xterm-helper-textarea');
    const cursor = terminal.locator('.xterm-cursor-blink.xterm-cursor-block');
    await focus.click();
    await cursor.waitFor();

    async function assertCursor(blinking) {
      const style = await cursor.evaluate((element) => {
        const css = getComputedStyle(element);
        return { animation: css.animationName, background: css.backgroundColor, width: element.getBoundingClientRect().width };
      });
      assert.equal(style.animation !== 'none', blinking, JSON.stringify(style));
      if (!blinking) assert.ok(style.width > 0 && style.background !== 'rgba(0, 0, 0, 0)', JSON.stringify(style));
      assert.equal(await terminalInput.evaluate((element) => element === document.activeElement), true);
    }

    await assertCursor(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await assertCursor(false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await assertCursor(true);

    const settingsEntry = page.getByRole('button', { name: '设置', exact: true });
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    async function setAppMotion(label) {
      await settingsEntry.click();
      await openSettingsSection(settings, '交互');
      await settings.getByRole('group', { name: '动画', exact: true }).getByRole('button', { name: label, exact: true }).click();
      await settings.getByText('应用偏好已保存', { exact: true }).waitFor();
      await settings.getByRole('button', { name: '完成', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
      assert.equal(await settingsEntry.evaluate((element) => element === document.activeElement), true);
      await focus.click();
    }
    await setAppMotion('减少动画');
    await assertCursor(false);
    await setAppMotion('跟随系统');
    await assertCursor(true);

    const input = page.waitForRequest((request) => request.url().endsWith(terminalPath) &&
      request.method() === 'POST' && request.postDataJSON()?.op === 'native-input');
    const composer = terminal.getByRole('textbox', { name: 'Claude Code 消息', exact: true });
    await composer.fill('光标运行时测试');
    await composer.press('Enter');
    const packet = (await input).postDataJSON();
    assert.equal(packet.sessionId, sessionId);
    assert.equal(Buffer.from(packet.data, 'base64').toString('utf8'), '光标运行时测试\r');
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
    assert.equal(calls.filter(({ op }) => op === 'native-subscription-start').length, 1);
  });
