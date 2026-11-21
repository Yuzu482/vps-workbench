const utf8 = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size, signature) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return {
    bytes,
    u16(offset, value) { view.setUint16(offset, value, true); },
    u32(offset, value) { view.setUint32(offset, value, true); },
  };
}

// The workbench archives are small and the binary parts (JPEGs) are already compressed.
export function zip(entries, type = 'application/zip') {
  const parts = [];
  const directory = [];
  let offset = 0;
  let directoryLength = 0;
  for (const [name, data] of entries) {
    const filename = utf8.encode(name);
    const contents = typeof data === 'string' ? utf8.encode(data) : data;
    const checksum = crc32(contents);
    const local = header(30, 0x04034b50);
    local.u16(4, 20);
    local.u16(6, 0x0800);
    local.u16(12, 0x0021);
    local.u32(14, checksum);
    local.u32(18, contents.length);
    local.u32(22, contents.length);
    local.u16(26, filename.length);
    parts.push(local.bytes, filename, contents);

    const item = header(46, 0x02014b50);
    item.u16(4, 20);
    item.u16(6, 20);
    item.u16(8, 0x0800);
    item.u16(14, 0x0021);
    item.u32(16, checksum);
    item.u32(20, contents.length);
    item.u32(24, contents.length);
    item.u16(28, filename.length);
    item.u32(42, offset);
    directory.push(item.bytes, filename);
    directoryLength += item.bytes.length + filename.length;
    offset += local.bytes.length + filename.length + contents.length;
  }
  const end = header(22, 0x06054b50);
  end.u16(8, entries.length);
  end.u16(10, entries.length);
  end.u32(12, directoryLength);
  end.u32(16, offset);
  return new Blob([...parts, ...directory, end.bytes], { type });
}
