import { workbenchStorage } from './workbench-storage.js';

export const maxDesignContextText = 24000;
export const maxArtboardSourceLength = 128 * 1024;
export const maxLayerEdits = 180;
export const playgroundPositionLimit = 100000;
export const designBriefFields = [
  ['goal', '目标与使用者', 600, '为谁设计，他们要完成哪件事？'],
  ['screens', '画板与关键状态', 700, '需要哪些页面、主要操作、空状态或错误状态？'],
  ['direction', '视觉方向', 600, '期望的气质、视觉参考、信息密度和主次关系'],
  ['constraints', '约束与验收', 600, '设备尺寸、必须保留的组件、无障碍或交付要求'],
];
export const designStyleLevels = [
  ['保守', '严格沿用已确认的配色、字体、构图和组件。以变化最小的方案满足要求。'],
  ['稳健', '沿用已有设计语言。可以改善层级和间距，并保持熟悉的组件和交互。'],
  ['平衡', '保持核心流程和品牌识别。在允许的范围内探索一处有明确价值的视觉变化。'],
  ['探索', '在任务范围内尝试不同的构图、层级或表现手法。保留清晰的可读性和交互。'],
  ['发散', '在允许的范围内尝试差异鲜明的方向。可以突破现有构图，但须遵守简报、主流程和必须保留的约束。'],
];

export function normalizeDesignStyle(value) {
  return Number.isInteger(value) && value >= 0 && value < designStyleLevels.length ? value : 2;
}
const maxLocalVersions = 100;
const maxSavedProject = 2 * 1024 * 1024;
const systemLibraryKey = 'dsh-vps-design-systems:v1';
const maxSystems = 20;
const maxImageBody = 524288;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const layerId = /^(?:e[0-9]{1,4}|n[0-9a-f]{16})$/;
const boardIndex = /^[1-6]$/;
const playgroundId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-6]$/i;
const maxPlaygroundPositions = 500;
const maxPrototypeLinks = 240;
const hex = /^#[0-9a-f]{6}$/i;
const numberEdits = {
  x: [-2160, 2160], y: [-2160, 2160], width: [1, 2160], height: [1, 2160], fontSize: [8, 144],
  padding: [0, 128], gap: [0, 128], borderRadius: [0, 128],
};
const choices = {
  align: ['left', 'center', 'right'],
  family: ['sans-serif', 'serif', 'monospace'],
  weight: ['400', '600', '700'],
};

export function designText(value, maximum) {
  return typeof value === 'string' ? value.replaceAll('\0', '').slice(0, maximum) : '';
}

export function readDesignSystems() {
  const data = workbenchStorage.getItem(systemLibraryKey);
  if (!data) return [];
  if (data.length > 500000) throw new Error('设计系统库超过大小限制。');
  const entries = JSON.parse(data);
  if (!Array.isArray(entries) || entries.length > maxSystems || entries.some((entry) =>
    typeof entry?.name !== 'string' || !entry.name.trim() || entry.name.length > 60 ||
    typeof entry?.text !== 'string' || !entry.text.trim() || entry.text.length > 10000)) {
    throw new Error('本机设计系统库无法读取。');
  }
  return entries;
}

export function saveDesignSystem(label, source) {
  const name = imageName(label).slice(0, 60);
  const text = designText(source, 10000);
  if (!name || !text.trim()) throw new Error('请填写设计系统名称和内容。');
  const entries = readDesignSystems();
  if (entries.some((entry) => entry.name === name)) throw new Error('已有同名设计系统。请输入新名称。');
  if (entries.length >= maxSystems) throw new Error('本机最多保存 20 套设计系统。');
  const next = [...entries, { name, text }].sort((a, b) => a.name.localeCompare(b.name));
  workbenchStorage.setItem(systemLibraryKey, JSON.stringify(next));
  return next;
}

export function rasterDataUrl(value) {
  if (typeof value !== 'string' || value.length > maxImageBody + 30) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length > maxImageBody || match[2].length % 4) return null;
  try {
    const signature = atob(match[2].slice(0, 16));
    const type = match[1].toLowerCase();
    if ((type === 'png' && signature.startsWith('\x89PNG\r\n\x1a\n')) ||
        (type === 'jpeg' && signature.startsWith('\xff\xd8\xff')) ||
        (type === 'webp' && signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP')) {
      return `data:image/${type};base64,${match[2]}`;
    }
  } catch {
    return null;
  }
  return null;
}

function imageName(value) {
  return designText(value, 120).replace(/[\p{C}]/gu, '').trim();
}

export async function makeDesignReference(file) {
  const name = imageName(file.name);
  if (!name || file.size > 12 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('请选择不超过 12 MB 的 PNG、JPEG 或 WebP。');
  }
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法缩小图片。');
    for (const size of [1280, 960, 720, 512]) {
      const scale = Math.min(1, size / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = rasterDataUrl(canvas.toDataURL('image/webp', 0.8));
      if (dataUrl) return { name, dataUrl };
    }
  } finally {
    image.close();
  }
  throw new Error('图片压缩后仍超过参考资料大小限制。');
}

export function normalizeEdit(value) {
  if (!value || typeof value !== 'object') return {};
  const edit = {};
  if (typeof value.text === 'string') edit.text = designText(value.text, 500);
  if (value.removed === true) edit.removed = true;
  if (value.inlineBlock === true) edit.inlineBlock = true;
  for (const key of ['color', 'background']) {
    if (typeof value[key] === 'string' && hex.test(value[key])) edit[key] = value[key];
  }
  for (const [key, [minimum, maximum]] of Object.entries(numberEdits)) {
    if (Number.isInteger(value[key]) && value[key] >= minimum && value[key] <= maximum) edit[key] = value[key];
  }
  for (const [key, values] of Object.entries(choices)) {
    if (values.includes(value[key])) edit[key] = value[key];
  }
  return edit;
}

export const emptyBoard = { edits: {}, additions: [], comments: [] };
export const layerRevisionMeta = 'dsh-layer-revision';

export function layerRevisionFields(editable) {
  return [...(editable ? ['text'] : []), 'color', 'background', 'fontSize',
    'align', 'family', 'weight', 'padding', 'gap', 'borderRadius'];
}

function normalizePlayground(value) {
  const positions = Object.fromEntries(Object.entries(value?.positions ?? {}).slice(-maxPlaygroundPositions)
    .filter(([id, point]) => playgroundId.test(id) && [point?.x, point?.y].every((coordinate) =>
      Number.isInteger(coordinate) && Math.abs(coordinate) <= playgroundPositionLimit))
    .map(([id, { x, y }]) => [id, { x, y }]));
  const links = new Map();
  if (Array.isArray(value?.links)) {
    for (const { from, layer, to } of value.links.slice(-maxPrototypeLinks).filter(Boolean)) {
      if ([from, layer, to].every((value) => typeof value === 'string') &&
          playgroundId.test(from) && layerId.test(layer) && (to === '' || playgroundId.test(to)) && from !== to) {
        links.set(`${from}:${layer}`, { from, layer, to });
      }
    }
  }
  return { positions, links: [...links.values()] };
}

export function normalizeBoard(value) {
  const edits = {};
  for (const [id, change] of Object.entries(value?.edits ?? {}).slice(0, maxLayerEdits)) {
    if (!layerId.test(id)) continue;
    const edit = normalizeEdit(change);
    if (Object.keys(edit).length) edits[id] = edit;
  }
  const additions = Array.isArray(value?.additions) ? value.additions : [];
  const comments = Array.isArray(value?.comments) ? value.comments : [];
  return {
    edits,
    additions: [...new Set(additions.filter((id) => typeof id === 'string' && id.startsWith('n') && layerId.test(id)))].slice(0, 30),
    comments: comments.slice(0, 40).flatMap((comment) => {
      if (!comment || (comment.layer !== '' && !layerId.test(comment.layer ?? ''))) return [];
      const text = designText(comment.text, 500).trim();
      return text ? [{ layer: comment.layer, label: designText(comment.label, 100), text }] : [];
    }),
  };
}

function normalizeLocalVersion(value) {
  if (typeof value?.id !== 'string' || typeof value.parentId !== 'string' ||
      !uuid.test(value.id) || !uuid.test(value.parentId) || value.id === value.parentId ||
      !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 6 ||
      value.sources.some((source) => typeof source !== 'string' || !source.trim() || source.length > maxArtboardSourceLength) ||
      !Array.isArray(value.origins) || value.origins.length !== value.sources.length ||
      value.origins.some((origin) => typeof origin?.versionId !== 'string' || !uuid.test(origin.versionId) ||
        !Number.isInteger(origin?.index) || origin.index < 1 || origin.index > 6)) return null;
  const { id, parentId, sources, origins } = value;
  return { id, parentId, sources, origins: origins.map(({ versionId, index }) => ({ versionId, index })) };
}

function normalizeProject(value) {
  const versions = {};
  for (const [id, boards] of Object.entries(value?.versions ?? {})) {
    if (!uuid.test(id)) continue;
    versions[id] = {};
    for (const [index, board] of Object.entries(boards ?? {})) {
      if (boardIndex.test(index)) versions[id][index] = normalizeBoard(board);
    }
  }
  const images = Array.isArray(value?.images) ? value.images.slice(0, 2).flatMap((image) => {
    const name = imageName(image?.name);
    const dataUrl = rasterDataUrl(image?.dataUrl);
    return name && dataUrl ? [{ name, dataUrl }] : [];
  }) : [];
  const localVersions = new Map();
  for (const valueVersion of Array.isArray(value?.localVersions) ? value.localVersions.slice(0, maxLocalVersions) : []) {
    const version = normalizeLocalVersion(valueVersion);
    if (version && !localVersions.has(version.id)) localVersions.set(version.id, version);
  }
  return {
    ...(localVersions.size && { localVersions: [...localVersions.values()] }),
    brief: {
      enabled: value?.brief?.enabled === true,
      ...Object.fromEntries(designBriefFields.map(([key, , limit]) => [key, designText(value?.brief?.[key], limit)])),
    },
    style: normalizeDesignStyle(value?.style),
    system: designText(value?.system, 10000),
    autoSystem: value?.autoSystem === true,
    references: designText(value?.references, 6000),
    images,
    versions,
    playground: normalizePlayground(value?.playground),
  };
}

export function readDesignProject(key, storage = workbenchStorage) {
  try {
    const saved = storage.getItem(key);
    if (saved && saved.length > maxSavedProject) throw new Error('Project too large');
    return { project: normalizeProject(saved ? JSON.parse(saved) : null), warning: '' };
  } catch {
    return { project: normalizeProject(null), warning: '无法读取本机设计记录，当前可继续编辑。' };
  }
}

export function saveDesignProject(key, project) {
  try {
    workbenchStorage.setItem(key, serializeDesignProject(project));
    return '';
  } catch {
    return '无法保存到本机，当前修改仅在本次打开期间保留。';
  }
}

export function serializeDesignProject(project) {
  const body = JSON.stringify(project);
  if (body.length > maxSavedProject) throw new Error('本机会话的设计记录已达到容量上限，请减少带入的画板。');
  return body;
}

export function addLocalDesignVersion(project, version, boards, links) {
  const saved = normalizeLocalVersion(version);
  const localVersions = project.localVersions ?? [];
  if (!saved || boards.length !== saved.sources.length || localVersions.some(({ id }) => id === saved.id)) {
    throw new Error('无法创建本机版本，请重新打开对比后再试。');
  }
  if (localVersions.length >= maxLocalVersions) throw new Error('本机会话的设计版本已达到上限。');
  if (project.playground.links.length + links.length > maxPrototypeLinks) {
    throw new Error('原型连线已达到保存上限，请减少带入的画板。');
  }
  return {
    ...project, localVersions: [...localVersions, saved],
    versions: { ...project.versions, [saved.id]: Object.fromEntries(boards.map((board, offset) =>
      [offset + 1, normalizeBoard(board)])) },
    playground: { ...project.playground, links: [...project.playground.links, ...links] },
  };
}

export function setDesignBoard(project, version, index, board) {
  return {
    ...project,
    versions: {
      ...project.versions, [version]: { ...project.versions[version], [index]: normalizeBoard(board) },
    },
  };
}

export function setPlaygroundPositions(project, moves) {
  const positions = { ...project.playground.positions };
  for (const [id, position] of moves) {
    delete positions[id];
    positions[id] = position;
  }
  return { ...project, playground: normalizePlayground({ ...project.playground, positions }) };
}

export function setPlaygroundLink(project, from, layer, to) {
  const links = project.playground.links.filter((link) => link.from !== from || link.layer !== layer);
  if (to != null) links.push({ from, layer, to });
  return { ...project, playground: normalizePlayground({ ...project.playground, links }) };
}

function designWorkflow(version, target) {
  if (target?.versionBoards?.length) return ['方案分支', '以指定来源版本为起点，保留仍需延续的流程与视觉规则。落实本轮指明的新方向。'];
  if (target?.intent === 'variants') return ['方案变体', '保持任务、内容和交互一致。让各方案在视觉层级、构图或风格上有可比较的差异。'];
  if (target?.layer) return ['图层迭代', target.revision
    ? '修改限在标记的元素及允许的属性。保留其它图层、画板结构与跳转。'
    : '把修改限在标记的元素及完成该修改必需的相邻布局。保留其它元素、页面结构和已有交互。'];
  if (target?.board) return ['画板迭代', '围绕这张来源画板修改。沿用现有的内容顺序、组件和交互，只改变本轮要求的范围。'];
  if (target?.continueBranch) return ['继续分支', '沿用这一分支已经确认的设计。以本轮需求决定哪些页面需要更新。'];
  return version
    ? ['持续迭代', '延续当前对话已确认的设计。保留用户未要求修改的内容、组件和交互。']
    : ['首稿', '先建立一致的视觉语言和清晰的主任务流程，优先完成简报要求的画板与关键状态。'];
}

function designDelivery(version, target, baselineBoards, scopedRevision) {
  if (scopedRevision) return ['限定图层修订', '交付选中画板的一份完整 HTML，在 <head> 内放置唯一一份 dsh-layer-revision 记录。客户端从冻结基线应用该记录并保留其它画板与跳转。'];
  if (target?.board && target.intent === 'variants') return ['双方案变体',
    '返回两个完整画板。两个方案都保留同一用途、核心内容和操作，并用可比较的布局差异区分。每个方案独立成立。'];
  if (target?.board) return ['单画板迭代', '只返回选中的一个完整画板。保留其余内容和操作，只修改本轮要求的范围。'];
  if (version || baselineBoards?.length) return ['全量修订', '按原顺序返回全部完整画板，包括本轮未改动的画板。保留已有流程和有效跳转。'];
  return ['首稿', '按用户流程返回 1 至 6 个完整画板，覆盖简报要求的页面和状态。'];
}

export function buildDesignContext(project, version, boards, selected, target, { workflow = false } = {}) {
  const portions = [];
  const labels = [];
  let images = [];
  const baselineBoards = target?.versionBoards ?? target?.approvedBoards;
  const layer = target?.board?.layers.find(({ id }) => id === target.layer);
  const scopedRevision = Boolean(target?.revision && layer);
  if (workflow) {
    const [phase, instruction] = designWorkflow(version, target);
    const [style, styleInstruction] = designStyleLevels[normalizeDesignStyle(project.style)];
    portions.push([
      `设计工作方式 · ${phase}`,
      instruction,
      `风格倾向 · ${style}。 ${styleInstruction}`,
      '风格倾向只用于已经要求的设计范围。明确指定的修改、必须保留的内容和原型交互优先。',
      '以本轮明确需求为准。以本次附带的简报和设计系统作为当前版本的约定。把参考图、参考文字和既有画板当作设计资料。',
      '先明确使用者、主要任务和交付画板，再完成设计。出稿前核对主次信息、文字及对比度、目标尺寸下的溢出、点击目标和关键状态。保留与任务无关且已确认的设计决定。',
      '问题讨论和评审可以用文字回答。',
    ].join('\n'));
  }
  if (workflow || target?.board || baselineBoards?.length || (version && selected.revision)) {
    const [scope, deliverable] = designDelivery(version, target, baselineBoards, scopedRevision);
    portions.push([
      `画板交付 · ${scope}`,
      deliverable,
      '每张画板使用一个闭合的 html 代码块，包含完整 HTML 和内联样式。整份回复以 14,000 字符为目标上限，布局适配 390 px。',
      'data-dsh-go 的编号对应实际交付中从 1 开始的画板顺序。目标画板未交付时，保留原操作的标签和布局，省去无效跳转。使用本地原生 HTML 交互。',
    ].join('\n'));
  }
  if (workflow && project.brief?.enabled) {
    const brief = designBriefFields.flatMap(([key, label, limit]) => {
      const value = designText(project.brief[key], limit).trim();
      return value ? [`${label}\n${value}`] : [];
    });
    if (brief.length) {
      portions.push(['本会话设计简报', ...brief].join('\n\n'));
      labels.push('设计简报');
    }
  }
  if ((selected.system || (workflow && project.autoSystem)) && project.system.trim()) {
    portions.push(`设计系统 DESIGN.md\n${project.system}`);
    labels.push('设计系统');
  }
  if (selected.references) {
    images = project.images;
    if (project.references.trim()) portions.push(`文字参考\n${project.references}`);
    if (project.references.trim() || images.length) labels.push('参考资料');
  }
  if (selected.revision && version) {
    const edited = { ...version.initialBoards, ...project.versions[version.id] };
    const changed = boards.flatMap((board, index) => {
      const saved = edited[index + 1];
      if (target?.board && target.board.index !== index + 1) return [];
      if (!saved || !(Object.keys(saved.edits).length || saved.additions?.length || saved.comments.length)) return [];
      return [{
        board: index + 1, title: board.title, added: saved.additions,
        edits: Object.entries(saved.edits).map(([id, changes]) => ({ id, original: board.original?.[id], changes })),
        comments: saved.comments,
      }];
    });
    if (changed.length) {
      portions.push(`设计版本 ${version.number} 的修改和批注\n${JSON.stringify(changed, null, 2)}`);
      labels.push('画布修改和批注');
    }
  }
  if (baselineBoards?.length) {
    const from = baselineBoards[0].version;
    const baselineLabel = target.versionBoards ? `Fork · 版本 ${from}` : `已校验画板 · 版本 ${from}`;
    const heading = target.versionBoards
      ? `从设计版本 ${from} 开始新分支。以下画板按原顺序提供，以此为基准修改。`
      : `以下是版本 ${from} 已应用并校验的画板。以这些内容作为当前设计基准。`;
    const snapshots = baselineBoards.map((board) => {
      const notes = designText((board.board ?? project.versions[board.versionId]?.[board.index])?.comments
        .map(({ label, text }) => `${label}：${text}`).join('\n'), 400);
      return { html: board.html, heading: `画板 ${board.index} · ${board.title}${notes ? `\n批注：${notes}` : ''}` };
    });
    const available = maxDesignContextText - [...portions, heading, ...snapshots.map((board) => board.heading)].join('\n\n').length
      - snapshots.length * 24;
    const share = Math.max(0, Math.floor(available / snapshots.length));
    if (share < 750 && snapshots.some((board) => board.html.length > share)) {
      return { context: null, labels: [baselineLabel], error: '附带资料过多，请减少设计资料后再发送本轮。' };
    }
    // Give shorter pages their complete HTML and transfer their unused space to longer pages.
    let remaining = available - snapshots.reduce((total, board) => total + Math.min(share, board.html.length), 0);
    portions.push(heading, ...snapshots.map((board) => {
      const extra = Math.max(0, Math.min(remaining, board.html.length - share));
      remaining -= extra;
      const html = designText(board.html, share + extra);
      return `${board.heading}\nHTML${html.length < board.html.length ? '（摘录）' : ''}\n${html}`;
    }));
    labels.push(baselineLabel);
  } else if (target?.board) {
    const { board, intent } = target;
    const notes = designText((board.board ?? project.versions[board.versionId]?.[board.index])?.comments
      .filter((entry) => !workflow || !layer || !entry.layer || entry.layer === layer.id)
      .map(({ label, text }) => `${label}：${text}`).join('\n'), 2000);
    const changes = layer?.editable ? { text: '修改后的文案' } : { borderRadius: 12 };
    const metadata = scopedRevision ? [
      '在交付的完整 HTML 的 <head> 中按以下格式写入唯一一份变更记录。',
      `<meta name="${layerRevisionMeta}" content='${JSON.stringify({ base: target.revision, layer: layer.id, changes })}'>`,
      '原样复制 base 和 layer。changes 只填本轮明确请求且受支持的属性。',
      `可用属性：${layerRevisionFields(layer.editable).join('、')}。`,
      '文字最多 500 字符，颜色用六位十六进制。fontSize 为 8 至 144 的整数，padding、gap、borderRadius 为 0 至 128 的整数像素。',
      'align 可用 left/center/right，family 可用 sans-serif/serif/monospace，weight 可用字符串 "400"/"600"/"700"。',
      'content 是 JSON 值，HTML 属性中的引号等字符按 HTML 转义。画布按这份记录更新目标图层，其他 HTML 只作为草稿。',
      '如果需求超出范围，用文字说明可改用「迭代此画板」。',
      ...(target.retryReason ? [`上一份结果的校验反馈：${target.retryReason}`] : []),
    ].join('\n') : '';
    const source = [
      target.fork && '以指定画板为基准开始新分支。',
      `选中画板：${board.title}（版本 ${board.version}，画板 ${board.index}）`,
      layer && `仅聚焦图层：${layer.label}（${layer.tag}，data-dsh-layer="${layer.id}"）。`,
      workflow && layer?.text && `当前图层文字：${designText(layer.text, 500)}`,
      scopedRevision && layer.style && `当前图层行内样式：${designText(layer.style, 600)}`,
      metadata,
      notes && `画板批注\n${notes}`,
    ].filter(Boolean).join('\n\n');
    labels.push(`${intent === 'variants' ? '变体' : scopedRevision ? '仅修改图层' : '迭代'} · ${layer?.label ?? board.title}`);
    const plainHeading = '画板 HTML\n';
    const available = maxDesignContextText - [...portions, source, plainHeading].join('\n\n').length;
    const excerpt = board.html.length > Math.min(11500, available);
    const heading = excerpt ? '画板 HTML（摘录）\n' : plainHeading;
    const limit = Math.min(11500, available - heading.length + plainHeading.length);
    if (limit < Math.min(750, board.html.length)) {
      return { context: null, labels, error: '附带资料过多，请减少本轮参考资料后再迭代。' };
    }
    portions.push(source, heading + designText(board.html, limit));
  }
  const text = portions.join('\n\n');
  const error = text.length > maxDesignContextText ? '本轮附带资料超过 24,000 字符，请缩减后再发送。' : '';
  return { context: !error && (text || images.length) ? { text, images } : null, labels, error };
}
