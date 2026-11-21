const chunkBytes = 1024 * 1024;
const maxArtifactBytes = 256 * chunkBytes;
const downloadType = 'application/octet-stream';

function plainText(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) ? null : text;
  } catch {
    return null;
  }
}

function downloadName(path) {
  const name = path.split(/[\\/]/u).at(-1)
    .replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/gu, '_').trim().replace(/[. ]+$/u, '');
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) ? `_${name}` : name || 'artifact';
}

function decodeFileData(data, size) {
  if (typeof data === 'string' && data.length === Math.ceil(size / 3) * 4) {
    try {
      const decoded = atob(data);
      if (decoded.length === size) {
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) bytes[index] = decoded.charCodeAt(index);
        return bytes;
      }
    } catch {
      // The response did not contain valid base64 data.
    }
  }
  throw new Error('产物文件内容不完整。');
}

async function prepareLargeFile(readChunk, { path, size }, signal, onProgress) {
  const chunks = [];
  let revision;
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const result = await readChunk(offset);
    if (signal.aborted) return null;
    const file = result?.file;
    if (!result?.ok || file?.path !== path || file.size !== size || file.offset !== offset ||
        typeof file.revision !== 'string' || !/^[0-9a-f]{64}$/u.test(file.revision) ||
        (revision !== undefined && file.revision !== revision)) {
      throw new Error('产物文件已变更或分段信息不完整。');
    }
    revision = file.revision;
    const bytes = decodeFileData(file.data, Math.min(chunkBytes, size - offset));
    chunks.push(bytes);
    onProgress(offset + bytes.length);
  }
  return new Blob(chunks, { type: downloadType });
}

export function createRunArtifacts(React, { button, note, alert }) {
  const h = React.createElement;

  function ArtifactDownload({ path, blob }) {
    const [url, setUrl] = React.useState(null);
    React.useLayoutEffect(() => {
      const nextUrl = URL.createObjectURL(blob);
      setUrl(nextUrl);
      return () => URL.revokeObjectURL(nextUrl);
    }, [blob]);

    return url && h('a', { className: 'vc-workflow-artifact-download', href: url, download: downloadName(path) }, '下载文件');
  }

  function ArtifactList({ run, index, readArtifacts }) {
    const [listing, setListing] = React.useState({ files: [], loading: true });
    const [selected, setSelected] = React.useState(null);
    const source = React.useRef({ run, index, readArtifacts });
    const listRequest = React.useRef(null);
    const fileRequest = React.useRef(null);

    React.useLayoutEffect(() => { source.current = { run, index, readArtifacts }; }, [run, index, readArtifacts]);
    const loadPage = React.useCallback(async (after) => {
      if (listRequest.current) return;
      const controller = new AbortController();
      listRequest.current = controller;
      const { run: currentRun, index: currentIndex, readArtifacts: read } = source.current;
      setListing((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const result = after
          ? await read(currentRun, currentIndex, undefined, controller.signal, { after })
          : await read(currentRun, currentIndex, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (!result?.ok || typeof result.truncated !== 'boolean' || !Array.isArray(result.files) || result.files.some((file) =>
          typeof file?.path !== 'string' || !file.path || !Number.isSafeInteger(file.size) || file.size < 0)) {
          throw new Error('无法读取产物列表。');
        }
        setListing((previous) => {
          const known = new Map(previous.files.map((file) => [file.path, file]));
          const lastPath = result.files.at(-1)?.path;
          const next = result.truncated && lastPath && (!after || lastPath > after) && !known.has(lastPath) ? lastPath : undefined;
          for (const file of result.files) {
            if (!known.has(file.path)) known.set(file.path, file);
          }
          return { files: [...known.values()], truncated: result.truncated, next, loading: false };
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          setListing((previous) => ({ ...previous, loading: false, error: error?.message || '无法读取产物列表。' }));
        }
      } finally {
        if (listRequest.current === controller) listRequest.current = null;
      }
    }, []);
    React.useLayoutEffect(() => {
      void loadPage();
      return () => {
        listRequest.current?.abort();
        listRequest.current = null;
        fileRequest.current?.abort();
        fileRequest.current = null;
      };
    }, [loadPage]);

    async function loadFile({ path, size }) {
      if (size > maxArtifactBytes) return;
      fileRequest.current?.abort();
      const controller = new AbortController();
      fileRequest.current = controller;
      const large = size > chunkBytes;
      setSelected({ path, size, loading: true, loaded: 0 });
      try {
        if (large) {
          const blob = await prepareLargeFile(
            (offset) => readArtifacts(run, index, path, controller.signal, { offset }),
            { path, size }, controller.signal,
            (loaded) => setSelected({ path, size, loading: true, loaded }));
          if (!controller.signal.aborted) setSelected({ path, size, blob });
        } else {
          const result = await readArtifacts(run, index, path, controller.signal);
          if (controller.signal.aborted) return;
          const file = result?.file;
          if (!result?.ok || file?.path !== path || file.size !== size) throw new Error('产物文件已变更，请重新打开产物列表。');
          const bytes = decodeFileData(file.data, size);
          setSelected({ path, size, text: plainText(bytes), blob: new Blob([bytes], { type: downloadType }) });
        }
      } catch (error) {
        if (!controller.signal.aborted) setSelected({ path, size, error: error?.message || '无法读取产物文件。' });
      } finally {
        if (fileRequest.current === controller) fileRequest.current = null;
      }
    }

    function selectFile(file) {
      if (file.size <= chunkBytes) {
        void loadFile(file);
        return;
      }
      if (selected?.path === file.path) return;
      fileRequest.current?.abort();
      setSelected(file);
    }

    const large = selected?.size > chunkBytes;
    const tooLarge = selected?.size > maxArtifactBytes;

    return h(React.Fragment, null,
      listing.files.length > 0 && h('ul', { className: 'vc-workflow-artifact-list', 'aria-label': '产物文件' },
        listing.files.map((file) => h('li', { key: file.path },
          button(file.path, () => selectFile(file), { 'aria-pressed': selected?.path === file.path }),
          h('span', { className: 'vc-workflow-note' }, `${file.size} 字节`)))),
      listing.loading && note('正在读取产物列表…', 'status'),
      alert(listing.error),
      listing.error && !listing.files.length && button('重试读取产物', () => loadPage()),
      !listing.files.length && !listing.loading && !listing.truncated && !listing.error && note('此阶段没有产物。', 'status'),
      listing.truncated && note('仅显示部分产物。', 'status'),
      listing.next && button('加载更多产物', () => loadPage(listing.next), { disabled: listing.loading }),
      large && h('p', { className: 'vc-workflow-note' }, h('code', null, selected.path), ` · ${selected.size} 字节`),
      tooLarge && note('此文件超过 256 MiB，无法在工作台下载。'),
      large && !tooLarge && !selected.blob && button(selected.error ? '重试准备下载' : '准备下载',
        () => loadFile(selected), { disabled: selected.loading }),
      selected?.error && alert(selected.error),
      selected?.loading && note(large ? `正在准备下载… 已读取 ${selected.loaded} / ${selected.size} 字节` : '正在读取产物文件…', 'status'),
      selected?.text === null && note('此文件无法以 UTF-8 文本预览，可下载查看。'),
      typeof selected?.text === 'string' && h('pre', { className: 'vc-workflow-text', tabIndex: 0, 'aria-label': '产物内容预览' }, selected.text),
      selected?.blob && h(ArtifactDownload, { key: selected.path, path: selected.path, blob: selected.blob }));
  }

  return function RunArtifacts({ run, index, readArtifacts }) {
    const [expanded, setExpanded] = React.useState(false);
    const regionId = React.useId();
    return h('div', { className: 'vc-workflow-artifacts' },
      button(expanded ? '收起产物' : '查看产物', () => setExpanded((visible) => !visible),
        { 'aria-expanded': expanded, 'aria-controls': regionId }),
      h('div', { id: regionId, hidden: !expanded, className: 'vc-workflow-artifact-content', role: 'group',
        'aria-label': `第 ${index + 1} 阶段产物` },
      expanded && h(ArtifactList, { run, index, readArtifacts })));
  };
}
