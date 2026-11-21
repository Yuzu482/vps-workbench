import { svgNode } from './theme-svg.js';

const steps = 60;
const samples = 20;
const fullTurn = Math.PI * 2;
let nextMaskId = 0;

function makeFlow(x, y, width, height) {
  const reach = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
  const between = (low, high) => low + (high - low) * Math.random();
  const turn = between(0, fullTurn);
  const clock = between(0, fullTurn);
  const driftX = .32 * (width * .55 - x) / reach + between(-.08, .08);
  const driftY = .32 * (height * .62 - y) / reach + between(.02, .12);
  const heading = Math.atan2(driftY, driftX);
  // The current carries dye into several counter-rotating, drifting vortices.
  const eddies = Array.from({ length: 6 }, (_, index) => {
    const angle = heading + index * fullTurn / 6 + between(-.45, .45);
    const distance = between(.13, .43);
    return {
      x: distance * Math.cos(angle), y: distance * Math.sin(angle),
      radiusSquared: between(.17, .29) ** 2,
      spin: between(7, 14) * (index % 2 ? 1 : -1),
    };
  });
  const plumes = Array.from({ length: 18 }, (_, index) => {
    const broad = index % 2 === 0;
    const angle = turn + index * fullTurn / 18 + between(-.46, .46);
    const speed = between(.64, broad ? 1.38 : 1.64) * (1 + .18 * Math.cos(angle - heading));
    const kickX = Math.cos(angle) * speed;
    const kickY = Math.sin(angle) * speed;
    const phase = between(0, fullTurn);
    const start = between(0, .065);
    const interval = between(.024, .033);
    const spread = broad ? between(.044, .091) : between(.010, .029);
    const tracks = Array.from({ length: samples }, (_, index) => {
      const birth = Math.round((start + index * interval) * steps);
      const wobble = .055 * Math.sin(phase + index * .28);
      const points = new Float32Array((steps + 1) * 2);
      let px = 0;
      let py = 0;
      for (let step = birth + 1; step <= steps; step++) {
        const time = step / steps;
        const age = (step - birth) / steps;
        const strength = Math.min(1, .18 + 3.2 * time) / (1 + .48 * age);
        const sway = .15 * Math.sin(clock + phase + age * 7) + wobble;
        let vx = strength * (kickX - sway * kickY) + driftX;
        let vy = strength * (kickY + sway * kickX) + driftY;
        for (const eddy of eddies) {
          const dx = px - eddy.x - driftX * time * .65;
          const dy = py - eddy.y - driftY * time * .65;
          const falloff = 1 + (dx * dx + dy * dy) / eddy.radiusSquared;
          const rotation = eddy.spin / (falloff * falloff);
          vx -= dy * rotation;
          vy += dx * rotation;
        }
        px += vx / steps;
        py += vy / steps;
        points[step * 2] = px;
        points[step * 2 + 1] = py;
      }
      const taper = Math.sin(Math.PI * (index + .08) / (samples - .84)) ** .64;
      return { birth, points, taper };
    });
    return { broad, spread, tracks, phase, density: broad ? between(.43, .62) : between(.24, .43) };
  });
  const directions = Array.from({ length: 48 }, (_, index) => {
    const angle = index * fullTurn / 48;
    return {
      x: Math.cos(angle), y: Math.sin(angle),
      shape: .17 * Math.sin(3 * angle + turn) + .09 * Math.sin(7 * angle + clock),
    };
  });
  return { reach, plumes, directions, driftX, driftY };
}

function smoothOutline(edge) {
  const pair = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const first = edge[0];
  const last = edge[edge.length - 1];
  let path = `M${pair((first.x + last.x) / 2, (first.y + last.y) / 2)}`;
  for (let index = 0; index < edge.length; index++) {
    const point = edge[index];
    const next = edge[(index + 1) % edge.length];
    path += `Q${pair(point.x, point.y)} ${pair((point.x + next.x) / 2, (point.y + next.y) / 2)}`;
  }
  return path + 'Z';
}

function setRibbonNormals(points) {
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const before = points[Math.max(index - 1, 0)];
    const after = points[Math.min(index + 1, points.length - 1)];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    point.nx = -dy / length;
    point.ny = dx / length;
  }
}

function ribbon(points, spread, offset) {
  if (points.length < 2) return '';
  const left = [];
  const right = [];
  for (const { x, y, width, nx, ny } of points) {
    const radius = width * spread;
    left.push({ x: x + nx * (offset * width + radius), y: y + ny * (offset * width + radius) });
    right.push({ x: x + nx * (offset * width - radius), y: y + ny * (offset * width - radius) });
  }
  // Use the successive dye samples as control points to round each boundary.
  return smoothOutline([...left, ...right.reverse()]);
}

export function createPigmentMask(root, x, y, width, height) {
  const document = root.ownerDocument;
  const id = `vc-pigment-${++nextMaskId}`;
  const { reach, plumes, directions, driftX, driftY } = makeFlow(x, y, width, height);
  const blur = Math.max(3.2, Math.min(10, reach * .0063));
  const feather = blur * 2.15;
  const edgeBlur = Math.min(feather, 8);
  const radii = new Float32Array(directions.length);
  const svg = svgNode(document, 'svg', {
    width: 0, height: 0, 'aria-hidden': 'true', 'data-vc-pigment': id,
    style: 'position:fixed;inset:0;overflow:hidden;pointer-events:none',
  });
  const defs = svgNode(document, 'defs', {});
  const mask = svgNode(document, 'mask', {
    id, x: 0, y: 0, width, height, 'mask-type': 'alpha',
    maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
  });
  const origin = svgNode(document, 'g', { transform: `translate(${x} ${y})` });
  mask.append(origin);
  const filterId = `${id}-haze`;
  const filter = svgNode(document, 'filter', {
    id: filterId, filterUnits: 'userSpaceOnUse',
    x: -x - edgeBlur * 4, y: -y - edgeBlur * 4, width: width + edgeBlur * 8, height: height + edgeBlur * 8,
  });
  filter.append(svgNode(document, 'feGaussianBlur', { stdDeviation: edgeBlur }));
  defs.append(filter);
  const haze = svgNode(document, 'g', { fill: 'white', filter: `url(#${filterId})` });
  origin.append(haze);
  const diffusion = svgNode(document, 'path', { 'data-vc-diffusion-front': '' });
  haze.append(diffusion);
  const streams = svgNode(document, 'g', { opacity: .56 });
  origin.append(streams);
  const mist = svgNode(document, 'g', { fill: 'white' });
  const fibers = svgNode(document, 'g', { fill: 'white' });
  streams.append(mist, fibers);
  // The small details have an alpha edge of their own and share the same mask.
  const gradientId = `${id}-droplet`;
  const gradient = svgNode(document, 'radialGradient', { id: gradientId });
  for (const [offset, opacity] of [[0, 1], [.42, .87], [.73, .41], [1, 0]]) {
    gradient.append(svgNode(document, 'stop', { offset, 'stop-color': 'white', 'stop-opacity': opacity }));
  }
  defs.append(gradient);
  const dropletFill = `url(#${gradientId})`;
  const drop = svgNode(document, 'ellipse', { rx: 4, ry: 4, opacity: .95, fill: dropletFill });
  const cloud = svgNode(document, 'ellipse', { rx: 5, ry: 5, opacity: .42, fill: dropletFill });
  mist.append(cloud);
  fibers.append(drop);
  for (const plume of plumes) {
    if (plume.broad) {
      plume.halo = svgNode(document, 'path', { opacity: .38 * plume.density });
      haze.append(plume.halo);
    }
    plume.wash = svgNode(document, 'path', { opacity: .85 * plume.density });
    plume.vein = svgNode(document, 'path', { opacity: .55 * plume.density });
    mist.append(plume.wash);
    fibers.append(plume.vein);
  }
  defs.append(mask);
  svg.append(defs);
  document.body.append(svg);

  let previous = -1;
  function draw(time) {
    if (time === previous) return;
    previous = time;
    const step = time * steps;
    const lower = Math.floor(step);
    const upper = Math.min(steps, lower + 1);
    const fraction = step - lower;
    // The initial drop dissolves into the faster streams and diffuses at their source.
    const dropSize = 4 + .019 * reach * Math.sqrt(time);
    drop.setAttribute('rx', dropSize * 1.18 * (1 - time * .20));
    drop.setAttribute('ry', dropSize * 1.18 * (1 + time * .21));
    drop.setAttribute('opacity', .95 * Math.max(0, 1 - time / .39) ** 1.25);
    const cloudSize = 5 + .046 * reach * Math.sqrt(time);
    cloud.setAttribute('cx', driftX * reach * time * .11);
    cloud.setAttribute('cy', driftY * reach * time * .18);
    cloud.setAttribute('rx', cloudSize * 1.10);
    cloud.setAttribute('ry', cloudSize * 1.41);
    cloud.setAttribute('opacity', .42 * (1 - time * .77));
    const leading = [];
    for (const plume of plumes) {
      const active = plume.tracks.filter((track) => track.birth <= step);
      const points = active.map(({ points, birth, taper }, index) => {
        const px = points[lower * 2] * (1 - fraction) + points[upper * 2] * fraction;
        const py = points[lower * 2 + 1] * (1 - fraction) + points[upper * 2 + 1] * fraction;
        const age = (step - birth) / steps;
        const billow = .85 + .15 * Math.sin(plume.phase + index * .48 - time * 7);
        return {
          x: px * reach, y: py * reach,
          width: reach * plume.spread * Math.sqrt(age) * taper * billow,
        };
      });
      setRibbonNormals(points);
      plume.halo?.setAttribute('d', ribbon(points, 2.85, .36 * Math.sin(plume.phase)));
      plume.wash.setAttribute('d', ribbon(points, 1.37, 0));
      plume.vein.setAttribute('d', ribbon(points, .38, .33 * Math.sin(time * 8 + plume.phase)));
      if (plume.broad && points.length) leading.push(points[0]);
    }

    // Keep the absorbed color behind the moving dye. Nearby streams pull the
    // feathered front forward, and the front eventually covers even the farthest corner.
    const mixing = Math.sin(Math.PI * time);
    const spread = 3 + reach * 1.14 * time ** 1.95 + feather * 4 * time ** 3;
    const edge = directions.map((direction, index) => {
      let lead = 0;
      for (const point of leading) {
        const forward = direction.x * point.x + direction.y * point.y;
        if (forward <= 0) continue;
        const sideways = Math.abs(direction.x * point.y - direction.y * point.x);
        const weight = Math.max(0, 1 - sideways / (reach * .045 + forward * .40));
        lead = Math.max(lead, forward * weight ** 2);
      }
      const radius = spread + mixing * (spread * direction.shape + .29 * lead);
      radii[index] = radius;
      return { x: direction.x * radius, y: direction.y * radius };
    });
    diffusion.setAttribute('d', smoothOutline(edge));
  }

  function coverageAt(localX, localY) {
    const dx = localX - x;
    const dy = localY - y;
    const sector = ((Math.atan2(dy, dx) + fullTurn) % fullTurn) * radii.length / fullTurn;
    const index = Math.floor(sector);
    const fraction = sector - index;
    const radius = radii[index] * (1 - fraction) + radii[(index + 1) % radii.length] * fraction;
    const edge = Math.max(0, Math.min(1, .5 + (radius - Math.hypot(dx, dy)) / (4 * feather)));
    return edge * edge * (3 - 2 * edge);
  }

  return { url: `url("#${id}")`, draw, coverageAt, remove: () => svg.remove() };
}
