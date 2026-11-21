import { createBinaryMask } from './binary-reveal.js';
import { createElementMask } from './element-reveal.js';
import { createPigmentMask } from './pigment-flow.js';

const duration = 1120;
const animationName = 'vc-theme-switch';
const menuTones = ['--vc-accent', '--vc-on-accent', '--vc-surface', '--vc-line'];
const frameSamples = [
  [.25, .01], [.75, .01], [.99, .25], [.99, .75],
  [.75, .99], [.25, .99], [.01, .75], [.01, .25],
];
const providerEffects = new Map([
  ['codex', ['binary', createBinaryMask]],
  ['antigravity', ['elements', createElementMask]],
]);

function prepareMenu(root, bounds) {
  // The native popover is above the workbench snapshot, so sample the reveal at its center.
  const menu = root.querySelector('.vc-tool-palette:popover-open');
  if (!menu) return;
  const box = menu.getBoundingClientRect();
  const x = box.left + box.width / 2 - bounds.left;
  const y = box.top + box.height / 2 - bounds.top;
  const palette = getComputedStyle(root);
  const previous = menuTones.map((name) => [name, palette.getPropertyValue(name).trim()]);
  const replaced = [];
  const setProgress = (coverage) => menu.style.setProperty('--vc-menu-theme-coverage', `${coverage * 100}%`);
  return {
    x, y, setProgress,
    mix() {
      setProgress(0);
      const target = getComputedStyle(root);
      for (const [name, oldTone] of previous) {
        const newTone = target.getPropertyValue(name).trim();
        if (oldTone && newTone && oldTone !== newTone) {
          replaced.push([name, menu.style.getPropertyValue(name), menu.style.getPropertyPriority(name)]);
          menu.style.setProperty(name, `color-mix(in srgb, ${oldTone}, ${newTone} var(--vc-menu-theme-coverage))`);
        }
      }
    },
    clear() {
      for (const [name, value, priority] of replaced) {
        if (value) menu.style.setProperty(name, value, priority);
        else menu.style.removeProperty(name);
      }
      menu.style.removeProperty('--vc-menu-theme-coverage');
    },
  };
}

export function setToolTheme(root, tool) {
  if (!root) return;
  if (tool) root.dataset.toolTheme = tool;
  else delete root.dataset.toolTheme;
}

export async function transitionToolView(root, tool, origin, commit, signal, onReveal) {
  if (!root || !origin || !tool || root.dataset.toolTheme === tool ||
      typeof root.startViewTransition !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return commit();
  }

  const bounds = root.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return commit();
  const x = Math.max(0, Math.min(bounds.width, origin.x - bounds.left));
  const y = Math.max(0, Math.min(bounds.height, origin.y - bounds.top));
  let effect;
  let menu;
  let frame;
  const clear = () => {
    cancelAnimationFrame(frame);
    effect?.remove();
    menu?.clear();
    delete root.dataset.themeRipple;
    root.style.removeProperty('--vc-theme-mask');
  };

  const [kind, createMask] = providerEffects.get(tool) ?? ['pigment', createPigmentMask];
  let transition;
  try {
    root.dataset.themeRipple = kind;
    effect = createMask(root, x, y, bounds.width, bounds.height);
    menu = prepareMenu(root, bounds);
    root.style.setProperty('--vc-theme-mask', effect.url);
    // Capture the outgoing interface before React commits any of the destination view.
    transition = root.startViewTransition(async () => {
      if (signal?.aborted) return;
      await commit();
      if (!signal?.aborted) menu?.mix();
    });
  } catch {
    clear();
    return commit();
  }

  const stop = () => transition.skipTransition();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  void transition.ready.then(() => {
    const animation = root.getAnimations({ subtree: true }).find((item) => item.animationName === animationName);
    if (!animation) {
      stop();
      return;
    }
    // Follow the compositor clock so the effect and the two interface snapshots stay in sync.
    const paint = () => {
      const time = animation.effect.getComputedTiming().progress ?? 0;
      effect.draw(time);
      if (menu) menu.setProgress(effect.coverageAt(menu.x, menu.y));
      if (onReveal) {
        const coverage = frameSamples.reduce((sum, [x, y]) => (
          sum + effect.coverageAt(x * bounds.width, y * bounds.height)
        ), 0) / frameSamples.length;
        onReveal(root, coverage);
      }
      frame = requestAnimationFrame(paint);
    };
    paint();
  }, () => {});
  let resizeObserver;
  try {
    if (kind === 'elements') {
      // The captured view and the element paths use the same starting coordinates.
      resizeObserver = new ResizeObserver(() => {
        const next = root.getBoundingClientRect();
        if (Math.abs(next.width - bounds.width) > .5 || Math.abs(next.height - bounds.height) > .5) stop();
      });
      resizeObserver.observe(root, { box: 'border-box' });
    }
    await transition.finished;
  } finally {
    resizeObserver?.disconnect();
    signal?.removeEventListener('abort', stop);
    clear();
  }
}

export const themeRippleCss = `
  @keyframes ${animationName} {from,to {opacity:1}}
  [data-vps-chat][data-theme-ripple] .vc-tool-highlight {transition-property:transform,opacity}
  [data-vps-chat][data-theme-ripple] :is(.vc-tool-option,.vc-tool-trigger,.vc-composer-option,.vc-effort-steps span) {
    transition-property:none;
  }
  [data-vps-chat][data-theme-ripple]::view-transition {pointer-events:none}
  [data-vps-chat][data-theme-ripple]::view-transition-group(root) {animation:none}
  [data-vps-chat][data-theme-ripple=pigment]::view-transition-image-pair(root) {
    isolation:auto;
    background-color:var(--vc-accent);
  }
  [data-vps-chat][data-theme-ripple]::view-transition-old(root),
  [data-vps-chat][data-theme-ripple]::view-transition-new(root) {
    animation:${animationName} ${duration}ms linear both;
    mix-blend-mode:normal;
    mask-repeat:no-repeat;
  }
  [data-vps-chat][data-theme-ripple=pigment]::view-transition-old(root) {
    /* Both palettes meet at the same wet edge, where the accent shows through. */
    mask-image:linear-gradient(#fff,#fff), var(--vc-theme-mask);
    mask-composite:exclude;
  }
  [data-vps-chat][data-theme-ripple]::view-transition-new(root) {
    mask-image:var(--vc-theme-mask);
  }
  [data-vps-chat][data-theme-ripple=elements]::view-transition-old(root),
  [data-vps-chat][data-theme-ripple=elements]::view-transition-new(root) {animation-duration:1840ms}
  [data-vps-chat][data-theme-ripple] > :is([data-vc-binary],[data-vc-elements]) {
    position:absolute; inset:0; pointer-events:none; view-transition-name:vc-theme-art;
  }
  [data-vps-chat][data-theme-ripple]::view-transition-group(vc-theme-art) {
    animation:none; z-index:2;
  }
  [data-vps-chat][data-theme-ripple]::view-transition-old(vc-theme-art) {display:none}
  [data-vps-chat][data-theme-ripple]::view-transition-new(vc-theme-art) {animation:none}
  @media (prefers-reduced-motion:reduce) {
    [data-vps-chat] > :is([data-vc-binary],[data-vc-elements]) {display:none}
    [data-vps-chat][data-theme-ripple]::view-transition-old(root),
    [data-vps-chat][data-theme-ripple]::view-transition-new(root) {animation:none; mask-image:none}
  }
`;
