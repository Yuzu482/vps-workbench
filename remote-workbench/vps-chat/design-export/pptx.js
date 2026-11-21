import { escapeMarkup } from './portable.js';
import { zip } from './zip.js';

const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const types = 'application/vnd.openxmlformats-officedocument.';
const namespaces = `xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${relationship}"`;
const slideWidth = 12192000;
const slideHeight = 6858000;

function xml(body) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
}

function relationships(entries) {
  return xml(`<Relationships xmlns="${packageNamespace}/relationships">` +
    entries.map(([type, target], index) =>
      `<Relationship Id="rId${index + 1}" Type="${relationship}/${type}" Target="${target}"/>`).join('') +
    '</Relationships>');
}

function slideData(shapes = '') {
  return '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes + '</p:spTree></p:cSld>';
}

const colorMapping = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';

function slidePicture({ title, width, height }) {
  const scale = Math.min(slideWidth / width, slideHeight / height);
  const cx = Math.round(width * scale);
  const cy = Math.round(height * scale);
  const x = Math.floor((slideWidth - cx) / 2);
  const y = Math.floor((slideHeight - cy) / 2);
  const name = escapeMarkup(title.replace(/[\x00-\x1f\x7f\ufffe\uffff]/g, ' '));
  return '<p:pic><p:nvPicPr>' +
    `<p:cNvPr id="2" name="${name}" descr="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/>` +
    '</p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/>' +
    '<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>' +
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

function theme() {
  const scheme = Object.entries({
    dk1: '181B21', lt1: 'FFFFFF', dk2: '283341', lt2: 'F1F4F6',
    accent1: '266F6B', accent2: '4168A4', accent3: '925D30', accent4: '885866',
    accent5: '595281', accent6: '497353', hlink: '194EA1', folHlink: '684584',
  }).map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('');
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const lines = [9525, 19050, 28575].map((width) => `<a:ln w="${width}">${fill}</a:ln>`).join('');
  return xml(`<a:theme xmlns:a="${drawing}" name="DSH"><a:themeElements>` +
    `<a:clrScheme name="DSH">${scheme}</a:clrScheme>` +
    `<a:fontScheme name="DSH"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="DSH"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${lines}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
}

export function makePresentation(artboards) {
  const entries = [];
  const overrides = [];
  function add(path, type, contents) {
    overrides.push(`<Override PartName="/${path}" ContentType="${types}${type}"/>`);
    entries.push([path, xml(contents)]);
  }

  entries.push(['_rels/.rels', relationships([['officeDocument', 'ppt/presentation.xml']])]);
  const slides = artboards.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${3 + index}"/>`).join('');
  add('ppt/presentation.xml', 'presentationml.presentation.main+xml',
    `<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>` +
    `</p:sldMasterIdLst><p:sldIdLst>${slides}</p:sldIdLst>` +
    `<p:sldSz cx="${slideWidth}" cy="${slideHeight}"/><p:notesSz cx="${slideHeight}" cy="${slideWidth}"/>` +
    '</p:presentation>');
  entries.push(['ppt/_rels/presentation.xml.rels', relationships([
    ['slideMaster', 'slideMasters/slideMaster.xml'], ['presProps', 'presProps.xml'],
    ...artboards.map((_, index) => ['slide', `slides/slide${index + 1}.xml`]),
  ])]);
  add('ppt/presProps.xml', 'presentationml.presProps+xml', `<p:presentationPr ${namespaces}/>`);

  add('ppt/slideMasters/slideMaster.xml', 'presentationml.slideMaster+xml',
    `<p:sldMaster ${namespaces}>${slideData()}` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');
  entries.push(['ppt/slideMasters/_rels/slideMaster.xml.rels', relationships([
    ['slideLayout', '../slideLayouts/slideLayout.xml'], ['theme', '../theme/theme.xml'],
  ])]);
  add('ppt/slideLayouts/slideLayout.xml', 'presentationml.slideLayout+xml',
    `<p:sldLayout ${namespaces} type="blank" preserve="1">${slideData()}${colorMapping}</p:sldLayout>`);
  entries.push(['ppt/slideLayouts/_rels/slideLayout.xml.rels', relationships([
    ['slideMaster', '../slideMasters/slideMaster.xml'],
  ])]);
  entries.push(['ppt/theme/theme.xml', theme()]);
  overrides.push(`<Override PartName="/ppt/theme/theme.xml" ContentType="${types}theme+xml"/>`);

  for (const [index, artboard] of artboards.entries()) {
    const id = index + 1;
    add(`ppt/slides/slide${id}.xml`, 'presentationml.slide+xml',
      `<p:sld ${namespaces}>${slideData(slidePicture(artboard))}${colorMapping}</p:sld>`);
    entries.push([`ppt/slides/_rels/slide${id}.xml.rels`, relationships([
      ['slideLayout', '../slideLayouts/slideLayout.xml'], ['image', `../media/board${id}.jpg`],
    ])], [`ppt/media/board${id}.jpg`, artboard.bytes]);
  }
  entries.unshift(['[Content_Types].xml', xml(`<Types xmlns="${packageNamespace}/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
    overrides.join('') + '</Types>')]);
  return zip(entries, `${types}presentationml.presentation`);
}
