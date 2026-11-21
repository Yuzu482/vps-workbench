import { zip } from './zip.js';

export function escapeMarkup(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const navigation = `(() => {
  const tabs = Array.from(document.querySelectorAll('[data-board-tab]'));
  const frames = Array.from(document.querySelectorAll('[data-board-frame]'));
  const bound = new WeakSet();

  function show(index) {
    for (let position = 0; position < frames.length; position++) {
      frames[position].hidden = position !== index;
      tabs[position].setAttribute('aria-pressed', String(position === index));
    }
  }

  function bind(frame) {
    const doc = frame.contentDocument;
    if (!doc?.body || bound.has(doc)) return;
    bound.add(doc);
    function follow(event) {
      const target = event.target?.closest?.('[data-dsh-go],[data-dsh-go-disabled]');
      const destination = target?.getAttribute('data-dsh-go');
      if (!/^[1-9][0-9]{0,2}$/.test(destination) || Number(destination) > frames.length) return;
      event.preventDefault();
      const index = Number(destination) - 1;
      show(index);
      tabs[index].focus();
    }
    doc.addEventListener('click', follow);
    doc.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target?.getAttribute?.('role') === 'link') follow(event);
    });
  }

  for (let index = 0; index < tabs.length; index++) {
    tabs[index].addEventListener('click', () => show(index));
    frames[index].addEventListener('load', () => bind(frames[index]));
    bind(frames[index]);
  }
})();`;

const handoff = `# DSH Design engineering handoff

Open index.html in a browser to review the current design offline. Use the
artboard tabs and the prototype links within each artboard.

Use design.json for artboard titles, order, and source paths. Each file under
artboards/ contains the standalone HTML and inline CSS for one artboard.
An element with data-dsh-go="2" opens the second artboard in index.html.
The same rule applies to every 1-based artboard number in design.json.

For implementation, pass this archive to the coding agent working in your
project. Point it to the relevant artboards and describe the expected behavior.
Use the HTML files to inspect and adapt content, styles, and layout. The archive
can be opened without a service account or a network connection.
`;

export function portableHtml(boards) {
  if (boards.length === 1) return boards[0].html;
  // Hash the exact navigation script above. Model HTML never runs scripts.
  const hash = 'luFX8NxhVLbbOlHmHL64RyiiLjveaN3ltLlnltMOYoI=';
  const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
  const tabs = boards.map(({ title }, index) => `<button type="button" data-board-tab aria-pressed="${index === 0}" ` +
    `aria-controls="design-board-${index + 1}">${escapeMarkup(title)}</button>`).join('');
  const frames = boards.map(({ title, html }, index) => `<iframe id="design-board-${index + 1}" data-board-frame ` +
    `sandbox="allow-same-origin" referrerpolicy="no-referrer" title="${escapeMarkup(title)}" ` +
    `srcdoc="${escapeMarkup(html)}"${index === 0 ? '' : ' hidden'}></iframe>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>DSH 设计原型</title><style>' +
    ':root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr);' +
    'font:14px system-ui,sans-serif;color:CanvasText;background:Canvas}' +
    'nav{display:flex;gap:.35rem;overflow:auto;padding:.65rem;border-bottom:1px solid GrayText}' +
    'button{border:1px solid GrayText;border-radius:.5rem;background:Canvas;color:CanvasText;padding:.45rem .8rem;' +
    'font:inherit;white-space:nowrap;cursor:pointer}' +
    "button[aria-pressed='true']{background:Highlight;color:HighlightText;border-color:transparent}" +
    'iframe{width:100%;height:100%;border:0;background:white}iframe[hidden]{display:none}</style></head>' +
    `<body><nav aria-label="画板">${tabs}</nav>${frames}<script>${navigation}</script></body></html>`;
}

export function projectArchive(boards) {
  const sources = boards.map(({ title, html }, index) => ({
    title, html, path: `artboards/${String(index + 1).padStart(2, '0')}.html`,
  }));
  return zip([
    ['index.html', portableHtml(boards)],
    ['design.json', JSON.stringify({
      version: 1, preview: 'index.html', artboards: sources.map(({ title, path }) => ({ title, path })),
    }, null, 2) + '\n'],
    ['HANDOFF.md', handoff],
    ...sources.map(({ path, html }) => [path, html]),
  ]);
}
