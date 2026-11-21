import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createDesignExport } from './index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('../../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const fixtures = [
  {
    title: '概览 <本地>',
    html: '<html><head><style>body{margin:0;background:#215b40;color:white}</style>' +
      '<style>@import url(https://export-fixture.invalid/blocked.css);</style></head>' +
      '<body><h1>设备面板</h1><button data-dsh-go="2">查看详情</button>' +
      '<main style="position:absolute;left:320px;top:144px;width:170px;height:80px;background:#d7bb6b">离线画板</main>' +
      '<script>alert("fixture")</script><img src="https://export-fixture.invalid/image.png"></body></html>',
  },
  {
    title: '详情',
    html: '<html><head><style>body{margin:0;background:#e9d9c4}h1{color:#463528}</style></head>' +
      '<body><h1>查看设备</h1><a data-dsh-go="1" href="https://export-fixture.invalid/">回到概览</a>' +
      '<footer style="height:920px">详情内容</footer></body></html>',
  },
];

const [older, newer] = ['872a1a95-fda3-4cab-9959-66a5ce56b6ef', '70b40797-23c2-45c2-8440-626c8afd385a'];
const selection = [[older, 6], ...[1, 2, 3, 4, 5, 6].map((index) => [newer, index]), [older, 3]]
  .map(([versionId, index], position) => ({
    id: `${versionId}:${index}`, versionId, index, title: `批量 ${position + 1}`,
    html: `<h1 data-dsh-layer="e1">批量画板 ${position + 1}</h1>`,
  }));
selection[0].html += '<button data-dsh-layer="e3" data-dsh-go="3">同版本跳转</button>' +
  '<button data-dsh-layer="n0123456789abcdef" data-dsh-go="3">手动覆盖跳转</button>' +
  '<div data-dsh-layer="e8" data-dsh-go="3">外层跳转' +
  '<button data-dsh-layer="e9" data-dsh-go="2">未选中的内置目标</button></div>' +
  '<button data-dsh-layer="e12" data-dsh-go="3">未选中的手动目标</button>';
selection[1].html += '<p data-dsh-layer="e8">新增手动跳转</p>';
const playgroundOptions = { playgroundLinks: [
  { from: selection[0].id, layer: 'n0123456789abcdef', to: selection[1].id },
  { from: selection[0].id, layer: 'e12', to: `${older}:2` },
  { from: selection[1].id, layer: 'e8', to: selection[0].id },
] };

function zipEntries(bytes) {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const length = bytes.readUInt32LE(offset + 18);
    const filenameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + filenameLength);
    const start = offset + 30 + filenameLength + extraLength;
    files.set(name, bytes.subarray(start, start + length));
    offset = start + length;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size);
  return files;
}

test('portable playground exports preserve the full selection and document limits', async () => {
  const boards = Array.from({ length: 500 }, (_, index) => ({
    title: `画板 ${index + 1}`, html: `<h1>画板 ${index + 1}</h1>`,
  }));
  const options = { playgroundLinks: [] };
  const html = await (await createDesignExport(boards, 'html', options)).text();
  assert.equal([...html.matchAll(/ data-board-frame /g)].length, 500);
  assert.match(html, /id="design-board-500"/);
  const archive = await createDesignExport(boards, 'zip', options);
  const files = zipEntries(Buffer.from(await archive.arrayBuffer()));
  assert.equal(files.get('index.html').toString(), html);
  const manifest = JSON.parse(files.get('design.json'));
  assert.deepEqual(manifest.artboards.map(({ title }) => title), boards.map(({ title }) => title));
  assert.ok(files.has('artboards/500.html'));
  await assert.rejects(createDesignExport([...boards, boards[0]], 'html', options), /500/);
  await assert.rejects(createDesignExport(selection, 'html'), /六/);
  for (const format of ['pdf', 'pptx']) {
    await assert.rejects(createDesignExport(selection, format, options), /六/);
  }
});

test('design exports preserve offline board navigation and create readable document files', { timeout: 45000 }, async () => {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents:
      `import { createDesignExport } from ${JSON.stringify(entry)}; window.exportFixture = createDesignExport;` },
    platform: 'browser', bundle: true, write: false,
  });
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--disable-background-networking'],
  });
  const fixtureFile = fileURLToPath(new URL(`./.export-fixture-${randomUUID()}.html`, import.meta.url));
  try {
    const archive = await createDesignExport(fixtures, 'zip');
    const files = zipEntries(Buffer.from(await archive.arrayBuffer()));
    assert.deepEqual([...files.keys()], ['index.html', 'design.json', 'HANDOFF.md', 'artboards/01.html', 'artboards/02.html']);
    const instructions = files.get('HANDOFF.md');
    assert.ok(instructions.every((byte) => byte < 128));
    assert.match(instructions.toString(), /index\.html[\s\S]+design\.json[\s\S]+artboards\//);
    const original = await (await createDesignExport(fixtures.slice(0, 1), 'html')).text();
    assert.equal(files.get('artboards/01.html').toString(), original);
    assert.doesNotMatch(original, /export-fixture\.invalid|<script\b/);
    assert.equal(JSON.parse(files.get('design.json')).artboards[0].title, fixtures[0].title);
    await writeFile(fixtureFile, files.get('index.html'), { flag: 'wx' });

    const page = await browser.newPage();
    const external = [];
    await page.route('https://export-fixture.invalid/**', (route) => {
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto(pathToFileURL(fixtureFile).href);
    const first = page.frameLocator('[id=design-board-1]');
    const second = page.frameLocator('[id=design-board-2]');
    await first.getByRole('button', { name: '查看详情' }).click();
    await second.getByRole('heading', { name: '查看设备' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '详情' }).getAttribute('aria-pressed'), 'true');
    await second.getByRole('link', { name: '回到概览' }).press('Enter');
    await first.getByRole('heading', { name: '设备面板' }).waitFor();

    const batch = await createDesignExport(selection, 'zip', playgroundOptions);
    const batchFiles = zipEntries(Buffer.from(await batch.arrayBuffer()));
    const batchHtml = await (await createDesignExport(selection, 'html', playgroundOptions)).text();
    assert.equal(batchFiles.get('index.html').toString(), batchHtml);
    assert.match(batchFiles.get('artboards/01.html').toString(), /data-dsh-go="8"[^>]*>同版本跳转/);
    await writeFile(fixtureFile, batchHtml);
    await page.reload();
    const tabs = page.locator('[data-board-tab]');
    assert.deepEqual(await tabs.allTextContents(), selection.map(({ title }) => title));
    const last = page.frameLocator('[id=design-board-8]');
    await first.getByRole('button', { name: '同版本跳转' }).click();
    await last.getByRole('heading', { name: '批量画板 8' }).waitFor();
    await tabs.first().click();
    await first.getByRole('button', { name: '手动覆盖跳转' }).click();
    await second.getByRole('heading', { name: '批量画板 2' }).waitFor();
    await second.getByRole('link', { name: '新增手动跳转' }).press('Enter');
    await first.getByRole('heading', { name: '批量画板 1' }).waitFor();
    for (const name of ['未选中的内置目标', '未选中的手动目标']) {
      const trigger = first.getByRole('button', { name });
      assert.equal(await trigger.getAttribute('data-dsh-go'), null);
      assert.equal(await trigger.getAttribute('data-dsh-go-disabled'), '');
      await trigger.click();
      assert.equal(await tabs.first().getAttribute('aria-pressed'), 'true');
    }

    await page.goto('about:blank');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const outputs = {};
    for (const format of ['pdf', 'pptx']) {
      outputs[format] = Buffer.from(await page.evaluate(async ({ boards, type }) => {
        const blob = await window.exportFixture(boards, type, { playgroundLinks: [] });
        return [...new Uint8Array(await blob.arrayBuffer())];
      }, { boards: fixtures, type: format }));
    }
    assert.deepEqual(external, []);
    assert.match(outputs.pdf.toString('ascii', 0, 8), /%PDF-1\.4/);
    const pdf = spawnSync('pdfinfo', ['-'], { input: outputs.pdf, encoding: 'utf8' });
    if (pdf.error?.code !== 'ENOENT') {
      assert.equal(pdf.status, 0, pdf.stderr);
      assert.match(pdf.stdout, /Pages:\s+2\b/);
      assert.match(pdf.stdout, /Page size:\s+810 x 506\.25 pts/);
    }
    const parts = zipEntries(outputs.pptx);
    assert.ok(parts.has('ppt/slideLayouts/slideLayout.xml'));
    assert.match(parts.get('ppt/presentation.xml').toString(), /<p:sldId id="257"/);
    assert.match(parts.get('ppt/slides/slide1.xml').toString(), /descr="概览 &lt;本地&gt;"/);
    const image = parts.get('ppt/media/board1.jpg');
    assert.equal(image.readUInt16BE(), 0xffd8);
    const [background, marker] = await page.evaluate(async (source) => {
      const picture = new Image();
      picture.src = 'data:image/jpeg;base64,' + source;
      await picture.decode();
      assertCanvasSize(picture);
      const canvas = document.createElement('canvas');
      canvas.width = picture.naturalWidth;
      canvas.height = picture.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(picture, 0, 0);
      return [[100, 500], [400, 190]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
      function assertCanvasSize(img) {
        if (img.naturalWidth !== 1080 || img.naturalHeight < 675) throw new Error('Wrong artboard dimensions');
      }
    }, image.toString('base64'));
    assert.ok(background.every((channel, index) => Math.abs(channel - [33, 91, 64, 255][index]) <= 2));
    assert.ok(marker.every((channel, index) => Math.abs(channel - [215, 187, 107, 255][index]) <= 2),
      'rendered foreground elements should preserve their layout and color');
    assert.equal(await page.evaluate(async (source) => {
      const picture = new Image();
      picture.src = 'data:image/jpeg;base64,' + source;
      await picture.decode();
      return picture.naturalHeight > 920;
    }, parts.get('ppt/media/board2.jpg').toString('base64')), true);
    const relationships = await page.evaluate((documents) => documents.map(([name, source]) => {
      const doc = new DOMParser().parseFromString(source, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error(`Invalid XML in ${name}`);
      return [name, [...doc.querySelectorAll('Relationship')].map((item) => ({
        target: item.getAttribute('Target'), mode: item.getAttribute('TargetMode'),
      }))];
    }), [...parts].filter(([name]) => /\.(xml|rels)$/.test(name))
      .map(([name, bytes]) => [name, bytes.toString()]));
    for (const [name, items] of relationships) {
      const base = name === '_rels/.rels' ? '' : name.split('/_rels/')[0];
      for (const { target, mode } of items) {
        assert.equal(mode, null);
        assert.ok(parts.has(posix.normalize(posix.join(base, target))), `Missing ${target} from ${name}`);
      }
    }
  } finally {
    await browser.close();
    await unlink(fixtureFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
