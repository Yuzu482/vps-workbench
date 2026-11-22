const workbenchTones = {
  chrome: '--vc-rail',
  surface: '--vc-surface',
  ink: '--vc-ink',
  muted: '--vc-muted',
  line: '--vc-line',
  hover: '--vc-hover',
  active: '--vc-tint',
  accent: '--vc-accent',
  frame: '--vc-line-strong',
};
const toneNames = Object.keys(workbenchTones);
const paletteTones = [...new Set([
  ...Object.values(workbenchTones),
  '--vc-canvas', '--vc-bubble', '--vc-on-accent', '--vc-warn', '--vc-warn-bg',
  '--vc-stage', '--vc-stage-dot', '--vc-overlay', '--vc-slider-track', '--vc-slider-fill',
  '--vc-slider-step', '--vc-slider-step-used', '--vc-slider-thumb',
])];
const appearanceProgress = '--vc-appearance-progress';
const appearanceTiming = { duration: 320, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' };
// Keep native color updates bounded during a compositor-driven reveal.
const colorSteps = 16;

function hexColor(channels) {
  return '#' + channels.slice(0, 3).map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

function cssColor(channels) {
  const [red, green, blue, alpha] = channels;
  return alpha === 255 ? hexColor(channels) : `rgb(${red} ${green} ${blue} / ${alpha / 255})`;
}

export function connectChromeColors(root, workbench, setWindowColors, onError, reducedMotion) {
  const sample = document.createElement('canvas');
  sample.width = sample.height = 1;
  const context = sample.getContext('2d', { willReadFrequently: true });
  let signature;
  let tool;
  let target;
  let displayed;
  let revealFrom;
  let revealStep = 0;
  let appearance;
  let css = {};

  function readColors() {
    const style = getComputedStyle(workbench);
    return Object.fromEntries(paletteTones.map((tone) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.getPropertyValue(tone).trim();
      context.fillRect(0, 0, 1, 1);
      return [tone, [...context.getImageData(0, 0, 1, 1).data]];
    }));
  }

  function display(palette, from = palette, amount = 1) {
    const colors = Object.fromEntries(toneNames.map((name) => {
      const tone = workbenchTones[name];
      return [tone, from[tone].map((channel, index) => Math.round(channel + (palette[tone][index] - channel) * amount))];
    }));
    const next = Object.fromEntries(toneNames.map((name) => [name, hexColor(colors[workbenchTones[name]])]));
    for (const name of toneNames) {
      if (next[name] !== css[name]) root.style.setProperty(`--desktop-${name}`, next[name]);
    }
    if (next.chrome !== css.chrome || next.ink !== css.ink || next.frame !== css.frame) {
      void setWindowColors({ color: next.chrome, symbolColor: next.ink, borderColor: next.frame }).catch(onError);
    }
    css = next;
    displayed = colors;
  }

  function stopAppearance() {
    if (!appearance) return;
    cancelAnimationFrame(appearance.frame);
    appearance.animation.cancel();
    for (const tone of appearance.tones) workbench.style.removeProperty(tone);
    delete root.dataset.appearanceTransition;
    appearance = undefined;
  }

  function fadeAppearance(from, to) {
    const tones = paletteTones.filter((tone) => cssColor(from[tone]) !== cssColor(to[tone]));
    if (!tones.length) return display(to);
    root.dataset.appearanceTransition = '';
    for (const tone of tones) {
      workbench.style.setProperty(tone,
        `color-mix(in srgb, ${cssColor(from[tone])}, ${cssColor(to[tone])} var(${appearanceProgress}))`);
    }
    const animation = workbench.animate([
      { [appearanceProgress]: '0%' }, { [appearanceProgress]: '100%' },
    ], appearanceTiming);
    animation.id = 'workbench-appearance';
    appearance = { animation, tones };
    display(from);
    // The live interface mixes its colors in CSS, and the window reads the same eased progress.
    function paint() {
      const progress = animation.effect.getComputedTiming().progress ?? 0;
      if (progress >= 1) {
        stopAppearance();
        display(to);
        return;
      }
      display(to, from, progress);
      appearance.frame = requestAnimationFrame(paint);
    }
    appearance.frame = requestAnimationFrame(paint);
  }

  function reveal(event) {
    const next = Math.round(event.detail * colorSteps);
    if (!revealFrom || next <= revealStep) return;
    revealStep = next;
    display(target, revealFrom, Math.min(1, revealStep / colorSteps));
  }

  workbench.addEventListener('workbench:theme-reveal', reveal);
  return {
    sync(theme) {
      const { vcAccent, toolTheme, vcMotion } = workbench.dataset;
      const next = `${theme}:${vcAccent}:${toolTheme}`;
      const revealActive = workbench.hasAttribute('data-theme-ripple') || workbench.hasAttribute('data-subscription-transition');
      const reduce = reducedMotion.matches || vcMotion === 'reduce';
      if (displayed && revealActive && !revealFrom) {
        revealFrom = displayed;
        revealStep = 0;
        if (appearance) {
          appearance.animation.pause();
          cancelAnimationFrame(appearance.frame);
        }
      }
      const revealEnded = !revealActive && Boolean(revealFrom);
      if (revealEnded) revealFrom = undefined;
      if (signature === next) {
        if (revealEnded || (appearance && reduce && !revealActive)) {
          stopAppearance();
          display(target);
        }
        return;
      }
      const animate = target && tool === toolTheme && !revealActive && !revealEnded && !reduce;
      const previous = animate && (appearance ? readColors() : target);
      stopAppearance();
      signature = next;
      tool = toolTheme;
      target = readColors();
      if (revealActive) return;
      if (previous) fadeAppearance(previous, target);
      else display(target);
    },
    disconnect() {
      stopAppearance();
      workbench.removeEventListener('workbench:theme-reveal', reveal);
    },
  };
}
