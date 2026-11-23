import { Lexer } from 'marked';
import { parse } from 'parse5';
import { designText, emptyBoard, rasterDataUrl, maxArtboardSourceLength } from './design-state.js';

const maxElementDepth = 100;
const maxLayers = 600;
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const contentPolicy = [
  "default-src 'none'", "style-src 'unsafe-inline'", "script-src 'none'", 'img-src data:',
  "font-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

const allowedElements = new Set(`
  a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup data dd del
  details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label
  li main mark menu meter nav ol optgroup option p pre progress q rp rt ruby s samp section select small span
  strong style sub summary sup table tbody td textarea tfoot th thead time title tr u ul var wbr
`.trim().split(/\s+/));
const voidElements = new Set(['br', 'col', 'hr', 'img', 'input', 'wbr']);
const textElements = new Set('a b button code dd div dt em figcaption h1 h2 h3 h4 h5 h6 label li p pre small span strong summary'.split(' '));
const commonAttributes = new Set(['id', 'class', 'style', 'title', 'dir', 'lang', 'role', 'hidden', 'tabindex']);
const elementAttributes = new Map([
  ['button', new Set(['disabled'])],
  ['col', new Set(['span'])],
  ['data', new Set(['value'])],
  ['details', new Set(['open', 'name'])],
  ['img', new Set(['alt', 'height', 'width'])],
  ['input', new Set(['type', 'value', 'name', 'placeholder', 'checked', 'disabled', 'readonly', 'min', 'max', 'step'])],
  ['label', new Set(['for'])],
  ['li', new Set(['value'])],
  ['meter', new Set(['value', 'min', 'max', 'low', 'high', 'optimum'])],
  ['ol', new Set(['start', 'reversed', 'type'])],
  ['optgroup', new Set(['label', 'disabled'])],
  ['option', new Set(['value', 'label', 'selected', 'disabled'])],
  ['progress', new Set(['value', 'max'])],
  ['select', new Set(['disabled', 'multiple', 'size'])],
  ['style', new Set(['media'])],
  ['td', new Set(['colspan', 'rowspan', 'headers'])],
  ['textarea', new Set(['placeholder', 'rows', 'cols', 'disabled', 'readonly'])],
  ['th', new Set(['colspan', 'rowspan', 'scope', 'headers'])],
  ['time', new Set(['datetime'])],
]);
const allowedInputTypes = new Set(['button', 'checkbox', 'email', 'number', 'password', 'radio', 'range', 'search', 'text']);
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function isClosedHtmlFence(token) {
  if (token.type !== 'code' || !/^html5?$/i.test(token.lang?.trim() ?? '')) return false;
  const lines = token.raw.split(/\r\n?|\n/);
  while (lines.length > 1 && /^[ \t]*$/.test(lines.at(-1))) lines.pop();
  if (lines.length < 3) return false;
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*html5?[ \t]*$/i.exec(lines[0]);
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1));
  return Boolean(opening && closing && opening[1][0] === closing[1][0] && closing[1].length >= opening[1].length);
}

export function extractHtmlFences(markdown, limit = 6) {
  if (markdown.length > maxArtboardSourceLength) return [];
  try {
    return Lexer.lex(markdown, { gfm: true }).filter((token) =>
      isClosedHtmlFence(token) && token.text.trim()).slice(0, limit).map((token) => token.text);
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => escapes[char]);
}

function safeCss(source) {
  const decoded = source.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\r\n\f])|\\(?:\r\n|[\r\n\f])/gi,
    (_, digits, character) => digits ? String.fromCodePoint(Math.min(parseInt(digits, 16), 0x10ffff)) : character ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b|(?:url|(?:-webkit-)?image-set|image|src)\s*\(|data\s*:/i.test(decoded)) return '';
  return source.replace(/<(?=[a-z!/?])/gi, '\\3c ');
}

function editStyles(edit, added = false) {
  const styles = added ? ['position:absolute', 'left:0', 'top:0', 'padding:8px'] : [];
  if (edit.inlineBlock) styles.push('display:inline-block !important');
  for (const [key, property] of [
    ['color', 'color'], ['background', 'background-color'], ['align', 'text-align'],
    ['family', 'font-family'], ['weight', 'font-weight'],
  ]) {
    if (edit[key] !== undefined) styles.push(`${property}:${edit[key]} !important`);
  }
  for (const [key, property] of [
    ['width', 'width'], ['height', 'height'], ['fontSize', 'font-size'],
    ['padding', 'padding'], ['gap', 'gap'], ['borderRadius', 'border-radius'],
  ]) {
    if (edit[key] !== undefined) styles.push(`${property}:${edit[key]}px !important`);
  }
  if (edit.x !== undefined || edit.y !== undefined) styles.push(`translate:${edit.x ?? 0}px ${edit.y ?? 0}px !important`);
  return styles.join(';');
}

function attributes(node, { id, edit = {}, image, prototypeDestination, layer } = {}) {
  const allowed = elementAttributes.get(node.tagName);
  const kept = new Map();
  if (node.tagName === 'button') kept.set('type', 'button');
  if (id) kept.set('data-dsh-layer', id);
  if (image) kept.set('src', image);
  let style = '';
  for (const attribute of node.attrs) {
    const { name, value } = attribute;
    if (attribute.namespace || attribute.prefix) continue;
    if (name === 'style') {
      if (node.tagName !== 'html') style = safeCss(value);
      continue;
    }
    if (name === 'data-dsh-go' && id && /^[1-6]$/.test(value)) {
      kept.set(name, value);
      continue;
    }
    if (name.startsWith('data-dsh-')) continue;
    if (!commonAttributes.has(name) && !allowed?.has(name) && !/^(?:aria|data)-[a-z0-9][a-z0-9_.-]*$/.test(name)) continue;
    if (node.tagName === 'input' && name === 'type' && !allowedInputTypes.has(value.toLowerCase())) continue;
    kept.set(name, value);
  }
  if (id && prototypeDestination) {
    const sourceLayer = node.attrs.find((attribute) => attribute.name === 'data-dsh-layer')?.value;
    const builtIn = kept.get('data-dsh-go');
    const destination = prototypeDestination(/^(?:e[0-9]{1,4}|n[0-9a-f]{16})$/.test(sourceLayer) ? sourceLayer : undefined,
      builtIn ? Number(builtIn) : undefined);
    if (Number.isInteger(destination) && destination >= 1 && destination <= 500) {
      kept.set('data-dsh-go', String(destination));
    } else {
      kept.delete('data-dsh-go');
      if (destination === 0) kept.set('data-dsh-go-disabled', '');
    }
  }
  if (kept.has('data-dsh-go')) {
    kept.set('tabindex', '0');
    if (node.tagName !== 'button') kept.set('role', 'link');
  }
  const editedStyle = editStyles(edit);
  if (style || editedStyle) {
    const combinedStyle = [style, editedStyle].filter(Boolean).join(';');
    kept.set('style', combinedStyle);
    if (layer) layer.style = designText(combinedStyle, 600);
  }
  return [...kept].map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
}

function serialize(node, state, depth = 0, visible = true) {
  if (depth > maxElementDepth) return '';
  if (node.nodeName === '#text') return visible ? escapeHtml(node.value) : '';
  const tag = node.tagName;
  if (node.namespaceURI !== htmlNamespace || !allowedElements.has(tag)) return '';
  if (tag === 'style') {
    const css = safeCss(node.childNodes.map((child) => child.value ?? '').join(''));
    return visible && css ? `<style${attributes(node)}>${css}</style>` : '';
  }
  const image = tag === 'img' ? rasterDataUrl(node.attrs.find((attribute) => attribute.name === 'src')?.value) : undefined;
  if (tag === 'img' && !image) return '';
  const id = state && state.count < maxLayers ? `e${++state.count}` : undefined;
  const edit = state?.board.edits[id] ?? {};
  const shown = visible && !edit.removed;
  const editable = textElements.has(tag) && !node.childNodes?.some((child) => child.tagName);
  let layer;
  if (id) {
    const originalText = node.childNodes?.map((child) => child.value ?? '').join('');
    const originalId = node.attrs.find((attribute) => attribute.name === 'id')?.value;
    const alt = node.attrs.find((attribute) => attribute.name === 'alt')?.value;
    state.original[id] = { tag, elementId: designText(originalId, 100), text: designText(originalText ?? alt, 500).trim() };
    if (shown) {
      const text = designText(edit.text ?? originalText, 500);
      const label = designText((text.trim() || originalId || alt || tag).replace(/\s+/g, ' '), 75);
      layer = { id, label, tag, depth, editable, text };
      state.layers.push(layer);
    }
  }
  const children = node.childNodes?.map((child) => serialize(child, state, depth + 1, shown)).join('') ?? '';
  if (!shown) return '';
  const opening = `<${tag}${attributes(node, { id, edit, image, prototypeDestination: state?.prototypeDestination, layer })}>`;
  if (voidElements.has(tag)) return opening;
  return opening + (editable && edit.text !== undefined ? escapeHtml(edit.text) : children) + `</${tag}>`;
}

export function createArtboard(source, board = emptyBoard, fallbackTitle = '画板', { prototypeDestination } = {}) {
  if (!source || source.length > maxArtboardSourceLength) return null;
  try {
    const parsed = parse(source, { scriptingEnabled: false });
    const html = parsed.childNodes.find((node) => node.tagName === 'html');
    const head = html?.childNodes.find((node) => node.tagName === 'head');
    const body = html?.childNodes.find((node) => node.tagName === 'body');
    if (!html || !head || !body) return null;
    const titleNode = head.childNodes.find((node) => node.tagName === 'title');
    const title = designText(titleNode?.childNodes.map((node) => node.value ?? '').join('').trim(), 80) || fallbackTitle;
    const state = { board, layers: [], original: {}, count: 0, prototypeDestination };
    const headContent = head.childNodes.filter((node) => node.tagName === 'style' || node.tagName === 'title')
      .map((node) => serialize(node, null)).join('');
    const bodyContent = body.childNodes.map((node) => serialize(node, state)).join('');
    const added = board.additions.map((id) => {
      const edit = board.edits[id] ?? {};
      if (edit.removed) return '';
      const text = edit.text ?? '';
      const style = editStyles(edit, true);
      state.layers.push({ id, label: designText(text, 75) || '形状', tag: 'div', depth: 0, editable: true, text, style });
      return `<div data-dsh-layer="${id}" style="${escapeHtml(style)}">${escapeHtml(text)}</div>`;
    }).join('');
    const bodyAttrs = attributes(body);
    const document = `<!doctype html><html${attributes(html)}><head><meta http-equiv="Content-Security-Policy" content="${contentPolicy}">` +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      headContent + `</head><body${bodyAttrs}>${bodyContent}${added}</body></html>`;
    const hasSurface = Boolean(bodyContent.trim() || added || headContent.includes('<style') || bodyAttrs.includes(' style="'));
    return { title, html: document, layers: state.layers, original: state.original, hasSurface };
  } catch {
    return null;
  }
}
