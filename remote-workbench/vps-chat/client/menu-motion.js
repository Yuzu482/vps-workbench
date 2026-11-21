const reducedMotion = `
  --vc-popup-duration:0ms; --vc-control-duration:0ms;
  --vc-slider-duration:0ms; --vc-slider-drag-duration:0ms;
`;

export const menuMotionCss = `
  @property --vc-effort-used {
    syntax:'<percentage>'; inherits:true; initial-value:0%;
  }
  [data-vps-chat], #root > .desktop-titlebar {
    --vc-popup-duration:180ms; --vc-control-duration:110ms;
    --vc-slider-duration:160ms; --vc-slider-drag-duration:80ms;
    --vc-motion-curve:cubic-bezier(.2,.7,.25,1);
  }
  :where([data-vps-chat], #root > .desktop-titlebar) .vc-popup-motion {
    --vc-popup-shift:6px;
    opacity:0; translate:0 var(--vc-popup-shift); scale:.99; pointer-events:none;
    transform-origin:center bottom;
    transition:opacity var(--vc-popup-duration) var(--vc-motion-curve),
      translate var(--vc-popup-duration) var(--vc-motion-curve),
      scale var(--vc-popup-duration) var(--vc-motion-curve),
      display var(--vc-popup-duration), overlay var(--vc-popup-duration);
    transition-behavior:allow-discrete;
  }
  :where([data-vps-chat], #root > .desktop-titlebar) .vc-popup-motion[data-side=below] {
    --vc-popup-shift:-6px; transform-origin:center top;
  }
  [data-vps-chat] dialog.vc-popup-motion {transform-origin:center}
  :where([data-vps-chat], #root > .desktop-titlebar) .vc-popup-motion:is(:popover-open,[open],[data-open=true]) {
    opacity:1; translate:0 0; scale:1; pointer-events:auto;
  }
  [data-vps-chat] dialog.vc-popup-motion::backdrop {
    opacity:0; pointer-events:none;
    transition:opacity var(--vc-popup-duration) var(--vc-motion-curve),
      display var(--vc-popup-duration), overlay var(--vc-popup-duration);
    transition-behavior:allow-discrete;
  }
  [data-vps-chat] dialog.vc-popup-motion[open]::backdrop {opacity:1; pointer-events:auto}
  @starting-style {
    :where([data-vps-chat], #root > .desktop-titlebar) .vc-popup-motion:is(:popover-open,[open],[data-open=true]) {
      opacity:0; translate:0 var(--vc-popup-shift); scale:.99;
    }
    [data-vps-chat] dialog.vc-popup-motion[open]::backdrop {opacity:0}
  }
  [data-vps-chat] .vc-disclosure-motion {
    display:grid; grid-template-rows:0fr; opacity:0; visibility:hidden;
    transition:grid-template-rows var(--vc-popup-duration) var(--vc-motion-curve),
      opacity var(--vc-popup-duration) var(--vc-motion-curve), visibility 0s linear var(--vc-popup-duration);
  }
  [data-vps-chat] .vc-disclosure-motion[data-expanded=true] {
    grid-template-rows:1fr; opacity:1; visibility:visible; transition-delay:0s;
  }
  [data-vps-chat] .vc-disclosure-clip {min-block-size:0; overflow:hidden}
  [data-vps-chat] .vc-details-motion {interpolate-size:allow-keywords}
  [data-vps-chat] .vc-details-motion::details-content {
    block-size:0; opacity:0; overflow:clip; pointer-events:none;
    transition:block-size var(--vc-popup-duration) var(--vc-motion-curve),
      opacity var(--vc-popup-duration) var(--vc-motion-curve), content-visibility var(--vc-popup-duration) allow-discrete;
  }
  [data-vps-chat] .vc-details-motion[open]::details-content {block-size:auto; opacity:1; pointer-events:auto}
  [data-vps-chat][data-vc-motion=reduce], #root[data-chrome-motion=reduce] > .desktop-titlebar {${reducedMotion}}
  @media (prefers-reduced-motion:reduce) {
    [data-vps-chat], #root > .desktop-titlebar {${reducedMotion}}
  }
`;

export function afterPopupMotion(element, complete) {
  const animations = element.getAnimations();
  if (!animations.length) {
    complete();
    return () => {};
  }
  let current = true;
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (current) complete();
  });
  return () => { current = false; };
}
