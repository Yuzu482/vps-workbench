import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtboard, extractHtmlFences } from './design-preview.js';
import { compareArtboards, markComparisonLayers, carriedBoard } from './design-comparison.js';
import { addLocalDesignVersion, buildDesignContext, readDesignProject, serializeDesignProject, emptyBoard } from './design-state.js';
import { layerRevisionKey, readLayerRevision, serializeLayerRevision } from './design-layer-revision.js';
import { setWorkbenchStorage } from './workbench-storage.js';

const version = { id: '00000000-0000-4000-8000-000000000011', number: 1 };
const revision = '00000000-0000-4000-8000-000000000012';
const turnId = '00000000-0000-4000-8000-000000000013';
const project = { versions: {}, system: '', references: '', images: [] };
const html = (title, body, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const fenced = (source) => ['```html', source, '```'].join('\n');
const fixtures = [
  html('首页', '<h1>活动首页</h1><button data-dsh-go="2">查看详情</button>'),
  html('详情', '<h1>活动详情</h1><button data-dsh-go="1">返回首页</button>'),
];
const boards = fixtures.map((source, index) => ({
  ...createArtboard(source), index: index + 1, versionId: version.id, version: version.number,
}));
const detail = boards[1];
const layer = detail.layers.find(({ tag }) => tag === 'button').id;

test('design delivery instructions match the board scope and the closed artboards are consumed in order', () => {
  const instructions = (target) => buildDesignContext(project, version, boards, {}, target, { workflow: true }).context.text;
  const full = instructions({ versionBoards: boards });
  assert.match(full, /画板交付 · 全量修订\n按原顺序返回全部完整画板/);
  assert.ok(full.indexOf('画板 1 · 首页') < full.indexOf('画板 2 · 详情'));
  assert.match(full, /闭合的 html 代码块.*14,000 字符.*390 px/);
  const single = instructions({ board: detail, intent: 'iterate' });
  assert.match(single, /画板交付 · 单画板迭代\n只返回选中的一个完整画板/);
  assert.match(single, /省去无效跳转/);
  assert.doesNotMatch(single, /画板 1 · 首页/);
  const variants = instructions({ board: detail, intent: 'variants' });
  assert.match(variants, /画板交付 · 双方案变体\n返回两个完整画板.*同一用途、核心内容和操作.*布局差异/);
  const scoped = instructions({ board: detail, intent: 'iterate', layer, revision });
  assert.match(scoped, /画板交付 · 限定图层修订\n.*<head>.*唯一一份/);
  assert.match(scoped, /原样复制 base 和 layer。changes 只填本轮明确请求且受支持的属性/);
  assert.doesNotMatch(scoped, /画板交付 · 单画板迭代/);

  const alt = html('详情变体', '<main style="display:grid"><button>返回首页</button><h1>活动详情</h1></main>');
  const oneBoard = fenced(html('详情', '<h1>活动详情</h1><button>返回首页</button>'));
  assert.equal(extractHtmlFences(oneBoard).length, 1);
  assert.equal(extractHtmlFences(`${oneBoard}\n\n${fenced(alt)}`).length, 2);
  const parsed = extractHtmlFences(`${fixtures.map(fenced).join('\n\n')}\n\n\`\`\`html\n<html>尚未闭合`);
  assert.deepEqual(parsed, fixtures);
  assert.match(createArtboard(parsed[0]).html, /data-dsh-go="2"/);
  assert.match(createArtboard(parsed[1]).html, /data-dsh-go="1"/);
  assert.doesNotMatch(createArtboard(extractHtmlFences(oneBoard)[0]).html, /data-dsh-go=/);
});

test('scoped revision requires a single record physically inside head and inherits the frozen boards and links', (t) => {
  const projectKey = 'design-delivery';
  const snapshot = {
    base: revision, sourceId: version.id, index: 2, layer, sources: fixtures,
    boards: { 1: { edits: { e1: { text: '已确认的首页' } } } },
    links: [{ from: `${version.id}:2`, to: `${version.id}:1`, layer }],
  };
  const records = new Map([[layerRevisionKey(projectKey, turnId), serializeLayerRevision(snapshot)]]);
  setWorkbenchStorage({ getItem: (key) => records.get(key) ?? null });
  t.after(() => setWorkbenchStorage(undefined));
  const meta = (value) => `<meta name="dsh-layer-revision" content='${JSON.stringify(value)}'>`;
  const change = { base: revision, layer, changes: { text: '返回活动首页' } };
  const record = meta(change);
  const apply = (reply) => readLayerRevision(projectKey, { id: turnId, state: 'complete', reply });
  const accepted = apply(fenced(html('草稿', '<h1>不应用生成的页面结构</h1>', record)));
  assert.equal(accepted.outcome, 'accepted');
  assert.deepEqual(accepted.sources, fixtures);
  assert.deepEqual(accepted.links, [{ from: `${turnId}:2`, to: `${turnId}:1`, layer }]);
  assert.match(createArtboard(accepted.sources[0], accepted.boards[1]).html, /已确认的首页/);
  assert.match(createArtboard(accepted.sources[1], accepted.boards[2]).html, /data-dsh-go="1"[^>]*>返回活动首页/);

  for (const source of [fenced(`<html><head></head>${record}<body>内容</body></html>`),
    fenced(html('正文中的记录', record)), fenced(html('重复记录', record, record)),
    fenced(html('基线错误', '', meta({ ...change, base: version.id }))),
    fenced(html('属性越界', '', meta({ ...change, changes: { width: 200 } })))]) {
    assert.equal(apply(source).outcome, 'rejected', source);
  }
});

test('comparison preserves identity across inserted layers and marks sanitized previews', () => {
  const capture = (id, sources) => ({
    id, entries: sources.map((source) => ({ source, preview: createArtboard(source) })),
  });
  const source = html('首页', '<main><p>记录</p><button id="cta">报名</button><p id="obsolete">旧通知</p></main>');
  const changed = html('首页', '<main><p>新公告</p><p>记录</p><button id="cta" style="color:red">确认报名</button></main>');
  const additional = html('新建页面', '<h1>新画板</h1>');
  const diffs = compareArtboards(capture(version.id, [source, fixtures[1]]), capture(turnId, [changed, additional]));
  assert.deepEqual(diffs.map(({ status }) => status), ['changed', 'added', 'removed']);
  assert.deepEqual(diffs[0].layers.map(({ status, left, right }) => [status, left?.label, right?.label]), [
    ['added', undefined, '新公告'], ['changed', '报名', '确认报名'], ['removed', '旧通知', undefined],
  ]);
  const marked = markComparisonLayers(diffs[0].after.preview.html, diffs[0].layers, 'right');
  assert.match(marked, /data-dsh-layer="e4"\]\{outline:2px solid/);
  assert.match(marked, /Content-Security-Policy/);
  const layoutBefore = html('布局', '<main><div id="one"><p id="text">原文</p></div><div id="two"></div></main>');
  const layoutAfter = html('布局', '<main><div id="one"></div><div id="two"><p id="text">原文</p></div></main>');
  const [layout] = compareArtboards(capture(version.id, [layoutBefore]), capture(turnId, [layoutAfter]));
  assert.deepEqual(layout.layers.map(({ status, right }) => [status, right.label]), [['changed', '原文']]);
});

test('carried boards retain edits, record provenance, and preserve only eligible original jumps', () => {
  const current = readDesignProject('fixture', { getItem: () => null }).project;
  const order = new Map([[version.id + ':2', turnId + ':1'], [version.id + ':1', turnId + ':2']]);
  const overrides = [{ from: version.id + ':2', layer, to: version.id + ':3' }];
  const first = carriedBoard(fixtures[1], detail.html, version.id + ':2', overrides, order);
  assert.deepEqual(first.links, []);
  assert.doesNotMatch(first.source, /data-dsh-go/);
  const second = carriedBoard(fixtures[0], boards[0].html, version.id + ':1', overrides, order);
  assert.deepEqual(second.links, [{ from: turnId + ':2', layer: 'e2', to: turnId + ':1' }]);
  const draft = { id: turnId, parentId: version.id, sources: [first.source, second.source],
    origins: [{ versionId: version.id, index: 2 }, { versionId: version.id, index: 1 }] };
  const edited = { ...emptyBoard, edits: { e1: { text: '来自父版的手动修改' } } };
  const next = addLocalDesignVersion(current, draft, [edited, emptyBoard], second.links);
  const restored = readDesignProject('fixture', { getItem: () => serializeDesignProject(next) }).project;
  assert.deepEqual(restored.localVersions, [draft]);
  assert.equal(restored.versions[turnId][1].edits.e1.text, '来自父版的手动修改');
  assert.deepEqual(restored.playground.links, second.links);
  assert.deepEqual(current.versions, {});
  assert.throws(() => serializeDesignProject({ payload: 'x'.repeat(2 * 1024 * 1024) }), /容量上限/);
});
