const utf8 = new TextEncoder();

export function makePdf(artboards) {
  const parts = [];
  const offsets = [0];
  let position = 0;
  function append(data) {
    const bytes = typeof data === 'string' ? utf8.encode(data) : data;
    parts.push(bytes);
    position += bytes.length;
  }
  function object(content, stream) {
    const id = offsets.length;
    offsets.push(position);
    append(`${id} 0 obj\n${content}`);
    if (stream) {
      append('\nstream\n');
      append(stream);
      append('\nendstream');
    }
    append('\nendobj\n');
  }

  append('%PDF-1.4\n');
  append(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object('<< /Type /Catalog /Pages 2 0 R >>');
  const children = artboards.map((_, index) => `${3 + index * 3} 0 R`);
  object(`<< /Type /Pages /Count ${artboards.length} /Kids [${children.join(' ')}] >>`);
  for (const { width, height, bytes } of artboards) {
    const widthPt = width * 0.75;
    const heightPt = height * 0.75;
    const image = offsets.length + 1;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
      `/Resources << /XObject << /Board ${image} 0 R >> >> /Contents ${image + 1} 0 R >>`);
    object(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`, bytes);
    const commands = utf8.encode(`q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Board Do\nQ\n`);
    object(`<< /Length ${commands.length} >>`, commands);
  }
  const xref = position;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
