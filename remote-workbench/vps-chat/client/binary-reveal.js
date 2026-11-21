import { svgNode } from './theme-svg.js';

let nextMaskId = 0;

function codeLine(length) {
  let bits = '';
  while (bits.length < length) {
    const count = 4 + Math.floor(Math.random() * 6);
    for (let index = 0; index < count && bits.length < length; index++) {
      bits += Math.random() < .5 ? '0' : '1';
    }
    if (bits.length < length) bits += ' ';
  }
  return bits;
}

function smooth(value) {
  const progress = Math.max(0, Math.min(1, value));
  return progress * progress * (3 - 2 * progress);
}

function rectangle(left, right, top, bottom) {
  if (right - left < .05) return '';
  return `M${left.toFixed(1)} ${top.toFixed(1)}H${right.toFixed(1)}V${bottom.toFixed(1)}H${left.toFixed(1)}Z`;
}

function createGlyphLayer(document, x, y, width, height, pitch) {
  const layer = svgNode(document, 'foreignObject', { x: -x, y: -y, width, height });
  const canvas = document.createElement('canvas');
  const ratio = document.defaultView.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.cssText = `display:block;width:${width}px;height:${height}px`;
  canvas.setAttribute('data-vc-binary-glyphs', '');
  layer.append(canvas);
  const paint = canvas.getContext('2d');
  if (!paint) throw new Error('Binary glyph layer is unavailable.');
  // Paint the glyphs at the current window pixel density before the reveal.
  paint.scale(canvas.width / width, canvas.height / height);
  paint.font = '550 13px Cascadia Mono, Consolas, monospace';
  paint.letterSpacing = `${pitch - paint.measureText('0').width}px`;
  paint.textBaseline = 'middle';
  paint.fillStyle = '#67ffec';
  return {
    layer,
    line(text, left, top, opacity) {
      paint.globalAlpha = opacity;
      paint.fillText(text, left + x, top + y);
    },
  };
}

export function createBinaryMask(root, x, y, width, height) {
  const document = root.ownerDocument;
  const id = `vc-binary-${++nextMaskId}`;
  const clipId = `${id}-front`;
  const transform = `translate(${x} ${y})`;
  const svg = svgNode(document, 'svg', {
    width, height, viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true', focusable: 'false', 'data-vc-binary': id,
  });
  const defs = svgNode(document, 'defs', {});
  const mask = svgNode(document, 'mask', {
    id, x: 0, y: 0, width, height, 'mask-type': 'alpha',
    maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
  });
  const maskOrigin = svgNode(document, 'g', { transform });
  const revealed = svgNode(document, 'path', { fill: 'white', d: '' });
  maskOrigin.append(revealed);
  mask.append(maskOrigin);
  const clip = svgNode(document, 'clipPath', { id: clipId });
  const activeBands = svgNode(document, 'path', { d: '' });
  clip.append(activeBands);
  defs.append(mask, clip);

  const art = svgNode(document, 'g', { transform, 'clip-path': `url(#${clipId})` });
  const backdrop = svgNode(document, 'rect', { x: -x, y: -y, width, height, fill: '#040b0e' });
  const dividers = svgNode(document, 'path', {
    fill: 'none', stroke: '#29d9c5', 'stroke-width': 1, opacity: .12,
  });
  art.append(backdrop, dividers);
  const leadingEdge = svgNode(document, 'path', {
    fill: 'none', stroke: '#32dcca', 'stroke-width': 1.2, opacity: .52,
  });
  const rowHeight = Math.max(22, Math.ceil(height / 54));
  const cellWidth = 10;
  const glyphs = createGlyphLayer(document, x, y, width, height, cellWidth);
  art.append(glyphs.layer);
  const columns = Math.ceil(width / cellWidth) + 2;
  const gridX = Math.floor(-x / cellWidth) * cellWidth + 1;
  const firstRow = Math.floor(-y / rowHeight + .5);
  const lastRow = Math.ceil((height - y) / rowHeight - .5);
  const rows = [];
  let grid = '';
  for (let index = firstRow; index <= lastRow; index++) {
    const center = index * rowHeight;
    const top = Math.max(-y, center - rowHeight / 2);
    const bottom = Math.min(height - y, center + rowHeight / 2);
    if (bottom <= top) continue;
    const distance = Math.abs(center) / Math.max(rowHeight, y, height - y);
    const delay = index === 0 ? 0 : .27 * distance + .025 * Math.random();
    rows.push({ top, bottom, delay, sweep: .43 + .055 * Math.random(), linger: .11 + .03 * Math.random(),
      reach: 0 });
    glyphs.line(codeLine(columns), gridX, center + 1, .48 + .48 * Math.random());
    grid += `M${-x} ${top + .5}H${width - x}`;
  }
  dividers.setAttribute('d', grid);
  art.append(leadingEdge);
  svg.append(defs, art);
  root.append(svg);

  const farthest = Math.max(x, width - x);
  const completeAt = Math.max(...rows.map(({ delay, sweep, linger }) => delay + sweep + linger));
  let previous = -1;
  function draw(progress) {
    const time = Math.min(progress, completeAt);
    if (time === previous) return;
    previous = time;
    let nextPalette = '';
    let bands = '';
    let edges = '';
    for (const row of rows) {
      const { top, bottom, delay, sweep, linger } = row;
      const leading = farthest * smooth((time - delay) / sweep);
      row.reach = farthest * smooth((time - delay - linger) / sweep);
      const left = Math.max(-x, -leading);
      const right = Math.min(width - x, leading);
      const paintedLeft = Math.max(-x, -row.reach);
      const paintedRight = Math.min(width - x, row.reach);
      nextPalette += rectangle(paintedLeft, paintedRight, top, bottom);
      bands += rectangle(left, paintedLeft, top, bottom) + rectangle(paintedRight, right, top, bottom);
      if (left + .85 < paintedLeft) edges += `M${left + .7} ${top + .5}V${bottom - .5}`;
      if (right - .85 > paintedRight) edges += `M${right - .7} ${top + .5}V${bottom - .5}`;
    }
    revealed.setAttribute('d', nextPalette);
    activeBands.setAttribute('d', bands);
    leadingEdge.setAttribute('d', edges);
  }

  function coverageAt(localX, localY) {
    const row = rows.find(({ top, bottom }) => localY - y >= top && localY - y <= bottom);
    return row ? smooth((row.reach - Math.abs(localX - x)) / (2 * cellWidth)) : 0;
  }

  return { url: `url("#${id}")`, draw, coverageAt, remove: () => svg.remove() };
}
