const desktopWidth = 1080;
const viewportHeight = 675;
const maximumHeight = 5400;
const loadTimeout = 8000;

function within(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), loadTimeout);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function renderDocument(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.referrerPolicy = 'no-referrer';
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed', left: `-${desktopWidth * 2}px`, top: '0',
    width: `${desktopWidth}px`, height: `${viewportHeight}px`,
    border: '0', visibility: 'hidden', pointerEvents: 'none',
  });
  try {
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    frame.srcdoc = html;
    document.body.append(frame);
    await within(loaded, '画板预览加载超时。');
    const doc = frame.contentDocument;
    if (!doc?.body || doc.URL !== 'about:srcdoc') throw new Error('画板预览无法读取。');
    const height = Math.max(viewportHeight, doc.documentElement.scrollHeight, doc.body.scrollHeight);
    if (height > maximumHeight) throw new Error(`画板内容超过 ${maximumHeight} 像素高。请拆分画板后再导出。`);
    const rootStyle = frame.contentWindow.getComputedStyle(doc.documentElement);
    const bodyStyle = frame.contentWindow.getComputedStyle(doc.body);
    const background = rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      ? bodyStyle.backgroundColor : rootStyle.backgroundColor;
    const copy = doc.documentElement.cloneNode(true);
    for (const meta of copy.querySelectorAll('meta')) meta.remove();
    // The exported image's dimensions are set by the scroll extent. The
    // foreign HTML document stays within the SVG image decoder's no-network mode.
    const markup = new XMLSerializer().serializeToString(copy);
    return { markup, height, background };
  } finally {
    frame.remove();
  }
}

export async function snapshotBoard(board) {
  const { markup, height, background } = await renderDocument(board.html);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${desktopWidth}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${desktopWidth}" height="${height}">${markup}</foreignObject></svg>`;
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  try {
    await within(image.decode(), '画板图像生成超时。');
  } catch {
    throw new Error('当前浏览器无法渲染此画板的导出图像。');
  }
  const canvas = document.createElement('canvas');
  canvas.width = desktopWidth;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, desktopWidth, height);
  context.fillStyle = background;
  context.fillRect(0, 0, desktopWidth, height);
  context.drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob || blob.type !== 'image/jpeg') throw new Error('画板图像无法保存。');
  return {
    title: board.title, width: desktopWidth, height,
    bytes: new Uint8Array(await blob.arrayBuffer()),
  };
}
