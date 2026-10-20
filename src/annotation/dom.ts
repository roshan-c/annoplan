/** Only renderer-owned text participates; controls and overlay labels never enter the index. */
export function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(
        '[data-annotation-overlay],script,style,[aria-hidden="true"]',
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}
export function plainText(root: HTMLElement): string {
  return textNodes(root)
    .map((n) => n.data)
    .join("");
}
export function rangeAt(
  root: HTMLElement,
  start: number,
  end: number,
): Range | null {
  let offset = 0;
  const range = document.createRange();
  let found = false;
  for (const node of textNodes(root)) {
    const next = offset + node.length;
    if (!found && start >= offset && start < next) {
      range.setStart(node, start - offset);
      found = true;
    }
    if (found && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}
export function selectionOffsets(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer) ||
    range.collapsed
  )
    return null;
  let offset = 0,
    start = -1,
    end = -1;
  for (const node of textNodes(root)) {
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += node.length;
  }
  // Native selections can end at an element boundary (e.g. Select All).
  if (start < 0 || end < 0) {
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const through = document.createRange();
    through.selectNodeContents(root);
    through.setEnd(range.endContainer, range.endOffset);
    start = before.toString().length;
    end = through.toString().length;
  }
  return end > start ? { start, end } : null;
}
