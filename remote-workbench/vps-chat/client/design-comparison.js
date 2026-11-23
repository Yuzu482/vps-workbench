import { parse, serialize } from 'parse5';

export const comparisonLabels = { added: '新增', removed: '移除', changed: '修改', unchanged: '无变化' };

function align(left, right, matchers) {
  const matches = new Map();
  const used = new Set();
  for (const key of matchers) {
    const unique = (items, skip) => {
      const keys = new Map();
      items.forEach((item, index) => {
        if (skip.has(index)) return;
        const value = key(item, index);
        if (value) keys.set(value, keys.has(value) ? -1 : index);
      });
      return keys;
    };
    const available = unique(right, used);
    for (const [value, index] of unique(left, matches)) {
      const other = available.get(value);
      if (index < 0 || other === undefined || other < 0) continue;
      matches.set(index, other);
      used.add(other);
    }
  }
  const reverse = new Map([...matches].map(([before, after]) => [after, before]));
  return [
    ...right.map((item, index) => [left[reverse.get(index)], item]),
    ...left.filter((_, index) => !matches.has(index)).map((item) => [item, undefined]),
  ];
}

function normalized(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function visit(node, callback, parent) {
  const nextParent = (node.attrs && callback(node, parent)) || parent;
  for (const child of node.childNodes ?? []) visit(child, callback, nextParent);
}

function layerRecords(preview) {
  const tree = new Map();
  visit(parse(preview.html, { scriptingEnabled: false }), (node, parent) => {
    const id = node.attrs.find(({ name }) => name === 'data-dsh-layer')?.value;
    if (!id) return undefined;
    const attrs = JSON.stringify(node.attrs.filter(({ name }) => name !== 'data-dsh-layer')
      .map(({ name, value }) => [name, value]).sort(([a], [b]) => a.localeCompare(b)));
    tree.set(id, { parent, attrs });
    return id;
  });
  return preview.layers.map((layer) => ({
    ...layer, elementId: preview.original?.[layer.id]?.elementId, ...tree.get(layer.id),
  }));
}

function layerChanges(before, after) {
  const original = before ? layerRecords(before.preview) : [];
  const candidate = after ? layerRecords(after.preview) : [];
  const pairs = align(original, candidate, [
    (layer) => before?.source === after?.source ? layer.id : '',
    (layer) => layer.elementId,
    (layer) => normalized(layer.text) && JSON.stringify([layer.tag, normalized(layer.text)]),
    (layer) => !layer.elementId && JSON.stringify([layer.id, layer.tag, layer.depth]),
  ]);
  const matched = new Map(pairs.filter(([left, right]) => left && right).map(([left, right]) => [left.id, right]));
  const matchedAtSameParent = new Set(original.filter((left) => {
    const right = matched.get(left.id);
    return right && (left.parent ? Boolean(right.parent && matched.get(left.parent)?.id === right.parent) : !right.parent);
  }).map(({ id }) => id));
  function siblingOrder(layers, included) {
    const offset = new Map();
    const order = new Map();
    for (const { id, parent } of layers) {
      if (!included.has(id)) continue;
      const index = offset.get(parent) ?? 0;
      order.set(id, index);
      offset.set(parent, index + 1);
    }
    return order;
  }
  const leftOrder = siblingOrder(original, matchedAtSameParent);
  const rightOrder = siblingOrder(candidate, new Set([...matchedAtSameParent].map((id) => matched.get(id).id)));
  return pairs.flatMap(([left, right]) => {
    const status = !left ? 'added' : !right ? 'removed' :
      left.text !== right.text || left.tag !== right.tag || left.depth !== right.depth || left.attrs !== right.attrs ||
      !matchedAtSameParent.has(left.id) || leftOrder.get(left.id) !== rightOrder.get(right.id)
        ? 'changed' : 'unchanged';
    return status === 'unchanged' ? [] : [{ status, left, right }];
  });
}

export function compareArtboards(original, candidate) {
  const entries = (version) => version.entries.map((entry, offset) => ({
    ...entry, index: offset + 1, versionId: version.id, origin: version.origins?.[offset],
  }));
  const left = entries(original);
  const right = entries(candidate);
  const leftSet = new Set(left);
  return align(left, right, [
    (entry) => {
      if (leftSet.has(entry)) return String(entry.index);
      return entry.origin?.versionId === original.id ? String(entry.origin.index) : '';
    },
    ({ preview }) => normalized(preview.title),
    ({ preview }) => {
      const identity = Object.values(preview.original ?? {}).flatMap(({ tag, elementId, text }) =>
        elementId ? [[tag, elementId]] : text ? [[tag, text]] : []);
      return identity.length ? JSON.stringify(identity) : '';
    },
    ({ index, preview }) => preview.layers.length > 1
      ? JSON.stringify([index, preview.layers.map(({ tag, depth }) => [tag, depth])]) : '',
  ]).map(([before, after]) => {
    const status = !before ? 'added' : !after ? 'removed' :
      before.index !== after.index || before.preview.html !== after.preview.html ? 'changed' : 'unchanged';
    const layers = status === 'unchanged' ? [] : layerChanges(before, after);
    return { before, after, status, layers };
  });
}

export function markComparisonLayers(html, changes, side) {
  const colors = { added: '#16834b', removed: '#bd3650', changed: '#7755cc' };
  const rules = changes.flatMap((change) => {
    const id = change[side]?.id;
    return /^(?:e[0-9]{1,4}|n[0-9a-f]{16})$/.test(id ?? '')
      ? ['[data-dsh-layer="' + id + '"]{outline:2px solid ' + colors[change.status] + ' !important;outline-offset:-2px !important}']
      : [];
  });
  return rules.length ? html.replace('</head>', '<style>' + rules.join('') + '</style></head>') : html;
}

export function carriedBoard(source, html, from, overrides, destinations) {
  const routes = new Map();
  visit(parse(html, { scriptingEnabled: false }), (node) => {
    const layer = node.attrs.find(({ name }) => name === 'data-dsh-layer')?.value;
    const target = node.attrs.find(({ name }) => name === 'data-dsh-go')?.value;
    if (layer && target) routes.set(layer, from.split(':')[0] + ':' + target);
  });
  for (const link of overrides) if (link.from === from) routes.set(link.layer, link.to);
  const links = [...routes].flatMap(([layer, target]) => {
    const to = destinations.get(target);
    return to && to !== destinations.get(from) ? [{ from: destinations.get(from), layer, to }] : [];
  });
  if (!/data-dsh-go/i.test(source)) return { source, links };
  const document = parse(source, { scriptingEnabled: false });
  visit(document, (node) => {
    node.attrs = node.attrs.filter(({ name }) => name !== 'data-dsh-go');
  });
  return { source: serialize(document), links };
}
