import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { startPreview } from './preview-server.mjs';
import { readWorkflows, workflowKey } from '../workflow-engine/state.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const previewStorageKey = 'vps-workbench-preview-state';

async function openPreview(t, { viewport = { width: 1280, height: 720 }, seed } = {}) {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const browser = await chromium.launch({ channel: 'msedge', args: ['--disable-background-networking', '--no-proxy-server'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await context.route('**/*', (route) => route.request().url().startsWith(preview.origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  if (seed) {
    const state = await (await fetch(preview.origin + '/__preview/state')).json();
    seed(state);
    await page.addInitScript(({ origin, key, state }) => {
      if (location.origin === origin && !sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(state));
    }, { origin: preview.origin, key: previewStorageKey, state });
  }
  await page.goto(preview.origin);
  return page;
}

async function readSavedWorkflows(page) {
  const raw = await page.evaluate(({ storage, key }) => JSON.parse(sessionStorage.getItem(storage)).preferences[key],
    { storage: previewStorageKey, key: workflowKey });
  return readWorkflows(raw);
}

test('P0 keeps unsaved workflow names and links until a guarded action succeeds', { timeout: 40_000 }, async (t) => {
  const otherId = 'a45320ea-6bca-4dc0-8255-9c63d4f40e27';
  const page = await openPreview(t, { seed(state) {
    const [original] = readWorkflows(state.preferences[workflowKey]);
    state.preferences[workflowKey] = JSON.stringify([original, { ...original, id: otherId, name: '第二个工作流' }]);
  } });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '工作流', exact: true });
  const prompt = page.getByRole('dialog', { name: '工作流有未保存的修改', exact: true });
  const choices = panel.getByLabel('已保存的工作流');
  const newWorkflow = panel.getByRole('button', { name: '新建工作流', exact: true });
  const name = panel.getByLabel('工作流名称');
  const stay = prompt.getByRole('button', { name: '留在当前', exact: true });
  const discard = prompt.getByRole('button', { name: '放弃修改', exact: true });
  const save = prompt.getByRole('button', { name: '保存并继续', exact: true });
  const [original] = await readSavedWorkflows(page);

  await choices.selectOption(otherId);
  assert.equal(await name.inputValue(), '第二个工作流');
  await newWorkflow.click();
  assert.equal(await prompt.isVisible(), false);
  assert.equal(await name.inputValue(), '');
  await choices.selectOption(original.id);
  await discard.click();
  assert.equal(await name.inputValue(), original.name);

  const edited = '活动页发布 · 未保存名称';
  await name.fill(edited);
  await newWorkflow.click();
  await stay.press('Enter');
  assert.equal(await name.inputValue(), edited);
  assert.equal(await newWorkflow.evaluate((button) => button === document.activeElement), true);

  await panel.getByRole('button', { name: /撰写页面文案/ }).first().click();
  const link = panel.getByRole('button', { name: '移除第 1 阶段到第 2 阶段的连接', exact: true });
  await link.click();
  await choices.selectOption(otherId);
  await prompt.waitFor();
  await page.keyboard.press('Escape');
  await prompt.waitFor({ state: 'hidden' });
  assert.equal(await choices.evaluate((select) => select === document.activeElement), true);
  assert.equal(await choices.inputValue(), original.id);
  assert.equal(await name.inputValue(), edited);
  assert.equal(await link.count(), 0);

  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  assert.equal(await name.inputValue(), edited);

  await page.evaluate((key) => {
    const base = window.vpsWorkbench.setPreference;
    window.workflowWrites = 0;
    window.rejectWorkflowWrite = true;
    window.vpsWorkbench.setPreference = async (name, value) => {
      if (name === key) {
        window.workflowWrites++;
        if (window.rejectWorkflowWrite) throw new Error('夹具模拟保存失败');
      }
      return base(name, value);
    };
  }, workflowKey);
  await choices.selectOption(otherId);
  await save.click();
  await prompt.getByRole('alert').getByText('夹具模拟保存失败', { exact: true }).waitFor();
  await stay.click();
  assert.equal(await choices.inputValue(), original.id);
  assert.equal(await name.inputValue(), edited);
  assert.equal(await link.count(), 0);
  assert.deepEqual((await readSavedWorkflows(page))[0], original);

  await name.fill('');
  await newWorkflow.click();
  await save.click();
  await prompt.getByRole('alert').getByText(/工作流名称/).waitFor();
  await stay.click();
  assert.equal(await name.inputValue(), '');
  assert.equal(await link.count(), 0);
  assert.equal(await page.evaluate(() => window.workflowWrites), 1);

  await name.fill(edited);
  await page.evaluate(() => { window.rejectWorkflowWrite = false; });
  await newWorkflow.click();
  await save.click();
  assert.equal(await name.inputValue(), '');
  const saved = (await readSavedWorkflows(page)).find(({ id }) => id === original.id);
  assert.equal(saved.name, edited);
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(saved.edges, original.edges.filter(({ from, to }) => from !== 's1' || to !== 's2'));
  assert.equal(await page.evaluate(() => window.workflowWrites), 2);

  await choices.selectOption(otherId);
  await discard.click();
  await name.fill('要明确放弃的修改');
  await choices.selectOption(original.id);
  await discard.click();
  assert.equal(await name.inputValue(), edited);
  await choices.selectOption(otherId);
  assert.equal(await name.inputValue(), '第二个工作流');
  assert.equal(await prompt.isVisible(), false);
});
