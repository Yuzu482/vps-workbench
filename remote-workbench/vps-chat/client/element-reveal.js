import { svgNode } from './theme-svg.js';

// Each run starts at a zero-based column and its first atomic number.
const periods = [
  [[0, 1, 'H'], [17, 2, 'He']],
  [[0, 3, 'Li Be'], [12, 5, 'B C N O F Ne']],
  [[0, 11, 'Na Mg'], [12, 13, 'Al Si P S Cl Ar']],
  [[0, 19, 'K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr']],
  [[0, 37, 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe']],
  [[0, 55, 'Cs Ba'], [3, 72, 'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn']],
  [[0, 87, 'Fr Ra'], [3, 104, 'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og']],
  [[3, 57, 'La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu']],
  [[3, 89, 'Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr']],
].map(runs => {
  const row = [];
  for (const [column, first, symbols] of runs) {
    symbols.split(' ').forEach((symbol, index) => { row[column + index] = { symbol, number: first + index }; });
  }
  return row;
});

const models = {
  H: { name: 'Hydrogen', light: '#2b62bb', dark: '#9bbdff' },
  C: { name: 'Carbon', light: '#127764', dark: '#90e3c9' },
  Ne: { name: 'Neon', light: '#754ac8', dark: '#cfb6ff' },
  Ar: { name: 'Argon', light: '#9e4c21', dark: '#ffc79b' },
};

const borderTracks = 2;
const columnCount = 18;
const rowAspect = .86;
const seriesStart = 7;
const seriesGap = .52;
let nextMaskId = 0;
const clamp = value => Math.min(1, Math.max(0, value));
const smooth = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const round = value => Number(value.toFixed(2));

function bounds(size, edges) {
  return [0, edges[0] / 2, ...edges, (edges.at(-1) + size) / 2, size].map(round);
}

function text(document, value, attrs) {
  const label = svgNode(document, 'text', attrs);
  label.textContent = value;
  return label;
}

function elementCard(document, element, palette, scheme, pitch, height) {
  const { number, symbol } = element;
  const model = models[symbol];
  const color = model?.[scheme] ?? palette.ink;
  const gap = Math.max(1.1, pitch * .05);
  const card = svgNode(document, 'g', {
    'data-element': symbol, 'data-atomic-number': number,
    ...(model && { 'data-model-element': model.name }),
    opacity: 0,
    'font-family': '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  });
  card.append(svgNode(document, 'rect', {
    x: -(pitch - gap) / 2, y: -(height - gap) / 2, width: pitch - gap, height: height - gap,
    rx: pitch * .12, fill: model
      ? `color-mix(in srgb, ${color} ${scheme === 'dark' ? 21 : 12}%, ${palette.surface})`
      : palette.surface,
    'fill-opacity': model ? .98 : .9,
    stroke: model ? color : palette.rule, 'stroke-opacity': model ? .68 : .72,
    'stroke-width': Math.max(.75, (model ? 1.2 : .75) * pitch / 60),
  }));
  if (pitch >= 24) {
    card.append(text(document, number, {
      x: -pitch * .35, y: -height * .23, fill: model ? color : palette.muted,
      'font-family': 'Cascadia Mono, Consolas, monospace', 'font-size': pitch * .17,
    }));
  }
  const hasModelName = model && pitch >= 42;
  card.append(text(document, symbol, {
    x: 0, y: height * (hasModelName ? .09 : .16), fill: color, 'text-anchor': 'middle',
    'font-size': pitch * .37, 'font-weight': model ? 670 : 540,
  }));
  if (hasModelName) {
    card.append(text(document, model.name, {
      x: 0, y: height * .35, fill: color, 'text-anchor': 'middle',
      'font-size': pitch * .15, 'font-weight': 600,
    }));
  }
  return card;
}

function distanceToEdge(position, direction, extent, padding) {
  if (!direction) return Infinity;
  const edge = direction > 0 ? extent + padding : -padding;
  return (edge - position) / direction;
}

function revealCell({ corners, progress, threshold }) {
  if (!progress) return '';
  const points = [];
  let previous = corners.at(-1);
  for (const corner of corners) {
    if ((previous.projection <= threshold) !== (corner.projection <= threshold)) {
      const fraction = (threshold - previous.projection) / (corner.projection - previous.projection);
      points.push([previous.x + (corner.x - previous.x) * fraction,
        previous.y + (corner.y - previous.y) * fraction]);
    }
    if (corner.projection <= threshold) points.push([corner.x, corner.y]);
    previous = corner;
  }
  return points.length ? `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z` : '';
}

export function createElementMask(root, x, y, width, height) {
  const document = root.ownerDocument;
  const id = `vc-elements-${++nextMaskId}`;
  const scheme = getComputedStyle(root).colorScheme === 'dark' ? 'dark' : 'light';
  const palette = scheme === 'dark'
    ? { surface: '#1b2332', ink: '#e3ebf9', muted: '#a6b4cc', rule: '#596d90' }
    : { surface: '#f5f8ff', ink: '#243956', muted: '#50698a', rule: '#95afd2' };
  const tableHeightInColumns = (periods.length + seriesGap) * rowAspect;
  const pitch = Math.min(width * .92 / columnCount, height * .82 / tableHeightInColumns);
  const rowHeight = pitch * rowAspect;
  const rowGap = rowHeight * seriesGap;
  const left = (width - columnCount * pitch) / 2;
  const top = (height - periods.length * rowHeight - rowGap) / 2;
  const columns = bounds(width, Array.from({ length: columnCount + 1 }, (_, column) => left + column * pitch));
  const rows = bounds(height, Array.from({ length: periods.length + 1 }, (_, row) =>
    top + row * rowHeight + (row >= seriesStart ? rowGap : 0)));
  const limits = { x: 0, y: 0, width, height };
  const svg = svgNode(document, 'svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, overflow: 'hidden',
    'aria-hidden': 'true', focusable: 'false', 'data-vc-elements': id,
  });
  const defs = svgNode(document, 'defs', {});
  const mask = svgNode(document, 'mask', {
    ...limits, id, 'mask-type': 'alpha', maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
  });
  const revealed = svgNode(document, 'path', { fill: '#fff', d: '' });
  mask.append(revealed);
  defs.append(mask);
  const art = svgNode(document, 'g', {});
  const seed = svgNode(document, 'circle', { cx: x, cy: y, r: 0, fill: '#8db8ff', opacity: 0 });
  art.append(seed);
  const horizontalReach = Math.max(x, width - x);
  const verticalReach = Math.max(y, height - y);
  const arrivalRange = Math.hypot(horizontalReach / width, verticalReach / height);
  const revealRange = Math.hypot(horizontalReach, verticalReach);
  const padding = pitch / 2 + 2;
  // Empty positions and margins have mask cells as well, so the same sweep replaces the whole view.
  const grid = rows.slice(0, -1).map((cellTop, row) => columns.slice(0, -1).map((cellLeft, column) => {
    const right = columns[column + 1];
    const bottom = rows[row + 1];
    const period = row - borderTracks;
    const centerX = (cellLeft + right) / 2;
    const centerY = (cellTop + bottom - (period === seriesStart - 1 ? rowGap : 0)) / 2;
    const distance = Math.hypot((centerX - x) / width, (centerY - y) / height) / arrivalRange;
    const element = periods[period]?.[column - borderTracks];
    const card = element && elementCard(document, element, palette, scheme, pitch, rowHeight);
    const featured = element && Object.hasOwn(models, element.symbol);
    const length = Math.hypot(centerX - x, centerY - y);
    const vx = length ? (centerX - x) / length : 0;
    const vy = length ? (centerY - y) / length : -1;
    const exitDistance = Math.min(distanceToEdge(centerX, vx, width, padding),
      distanceToEdge(centerY, vy, height, padding));
    const corners = [[cellLeft, cellTop], [right, cellTop], [right, bottom], [cellLeft, bottom]]
      .map(([px, py]) => ({ x: px, y: py, projection: vx * (px - x) + vy * (py - y) }));
    const projections = corners.map(corner => corner.projection);
    const first = Math.min(...projections);
    const last = Math.max(...projections);
    if (card) art.append(card);
    return {
      centerX, centerY, distance, card, featured, vx, vy, exitDistance, length, corners, first, last,
      arrival: 0, progress: 0, threshold: first, travel: null,
    };
  }));
  const flightRange = Math.max(...grid.flat().filter(cell => cell.card).map(cell => cell.exitDistance));
  svg.append(defs, art);
  root.append(svg);

  let last = -1;
  let lastSeedTime = -1;
  let lastFlight = 0;
  function draw(time) {
    if (time === last) return;
    last = time;
    const seedTime = Math.min(time, .21);
    if (seedTime !== lastSeedTime) {
      lastSeedTime = seedTime;
      seed.setAttribute('r', round(3 + 21 * smooth(seedTime / .2)));
      seed.setAttribute('opacity', round(.42 * smooth(seedTime / .03) * (1 - smooth((seedTime - .04) / .17))));
    }
    // A common outward displacement keeps the tiles separated as they leave along their entry rays.
    const flight = clamp((time - .61) / .37) ** 1.65;
    const flightChanged = flight !== lastFlight;
    const reach = revealRange * flight;
    let path = '';
    for (const row of grid) {
      for (const cell of row) {
        const { centerX, centerY, distance, card, featured, vx, vy, length, first, last, exitDistance } = cell;
        if (flightChanged) {
          // Reveal follows the departing cards and stays still during their hold.
          const start = Math.max(0, first);
          const progress = clamp((reach - start) / (last - start));
          cell.progress = progress;
          cell.threshold = progress === 1 ? last : first + (last - first) * progress;
          path += revealCell(cell);
        }
        if (!card) continue;

        const arrival = smooth((time - .035 - (featured ? .18 : .28) * distance) / .20);
        const arrivalChanged = arrival !== cell.arrival;
        if (arrivalChanged) {
          card.setAttribute('opacity', Math.min(1, arrival * 1.5).toFixed(3));
        } else if (!flightChanged) continue;
        cell.arrival = arrival;
        const travel = Math.min(exitDistance, flightRange * flight - length * (1 - arrival) * (featured ? .77 : .29));
        if (!arrivalChanged && cell.travel === travel) continue;
        cell.travel = travel;
        const dx = centerX + vx * travel;
        const dy = centerY + vy * travel;
        card.setAttribute('transform', `translate(${round(dx)} ${round(dy)}) scale(${round(.6 + .4 * arrival)})`);
      }
    }
    lastFlight = flight;
    if (flightChanged) revealed.setAttribute('d', path);
  }

  function coverageAt(localX, localY) {
    const row = rows.findIndex(value => value >= localY) - 1;
    const column = columns.findIndex(value => value >= localX) - 1;
    const cell = grid[row]?.[column];
    if (!cell?.progress) return 0;
    if (cell.progress === 1) return 1;
    return smooth((cell.threshold - cell.vx * (localX - x) - cell.vy * (localY - y)) / 6);
  }

  return { url: `url("#${id}")`, draw, coverageAt, remove: () => svg.remove() };
}
