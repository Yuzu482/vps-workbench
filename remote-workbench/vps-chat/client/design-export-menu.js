const formats = [['html', '下载 HTML'], ['zip', '下载 ZIP'], ['pdf', '下载 PDF'], ['pptx', '下载 PPTX']];

export function designExportMenu(boards, download, { busy, contextSelection = false } = {}) {
  const unavailable = !boards.length || boards.some(({ provisional, html }) => provisional || !html);
  return {
    summary: {
      title: `本次包含 ${boards.length} 张画板`,
      items: boards.map(({ id, version, title }) => ({ id, label: `版本 ${version} · ${title}` })),
    },
    actions: formats.map(([format, label]) => {
      const tooMany = boards.length > 6 && (format === 'pdf' || format === 'pptx');
      return {
        id: `export-${format}`, label: contextSelection ? `导出所选画板为 ${format.toUpperCase()}` : label,
        icon: 'download', disabled: unavailable || busy || tooMany,
        detail: tooMany ? '每次最多导出 6 张画板。' : undefined,
        run: () => download(format, boards),
      };
    }),
  };
}
