export function svgNode(document, type, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', type);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
