import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtboard, extractHtmlFences } from './design-preview.js';
import { buildDesignContext } from './design-state.js';
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
