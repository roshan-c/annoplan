import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import MarkdownIt from "markdown-it";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
});
// docx-preview expects a browser DOM. No resources or scripts are enabled.
for (const key of [
  "window",
  "document",
  "DOMParser",
  "XMLSerializer",
  "Node",
  "HTMLElement",
  "FileReader",
] as const)
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
  });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: dom.window.requestAnimationFrame.bind(dom.window),
  configurable: true,
});
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
function text(root: Element) {
  const walker = dom.window.document.createTreeWalker(
    root,
    dom.window.NodeFilter.SHOW_TEXT,
  );
  let result = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (
      !node.parentElement?.closest(
        'script,style,[aria-hidden="true"],[data-annotation-overlay]',
      )
    )
      result += node.textContent;
  }
  return result;
}
export interface TextPage {
  page: number | null;
  base_offset: number;
  text: string;
}
export async function extractText(
  path: string,
  format: string,
): Promise<TextPage[]> {
  const bytes = await readFile(path);
  if (format === "md") {
    const root = dom.window.document.createElement("div");
    root.innerHTML = md.render(new TextDecoder().decode(bytes));
    return [{ page: null, base_offset: 0, text: text(root) }];
  }
  if (format === "docx") {
    const { renderAsync } = await import("docx-preview");
    const root = dom.window.document.createElement("div");
    await renderAsync(Uint8Array.from(bytes).buffer, root, undefined, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      // Node's native Blob URLs avoid mixing JSDOM FileReader with native Blobs.
      // Asset encoding cannot contribute text nodes to the annotation index.
      useBase64URL: false,
      renderComments: false,
      renderAltChunks: false,
    });
    root
      .querySelectorAll("script,iframe,object,embed")
      .forEach((n) => n.remove());
    const value = text(root);
    for (const url of root.innerHTML.match(/blob:nodedata:[a-f0-9-]+/g) ?? [])
      URL.revokeObjectURL(url);
    return [{ page: null, base_offset: 0, text: value }];
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const task = getDocument({
    verbosity: 0,
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    cMapUrl: join(assets, "cmaps") + sep,
    cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts") + sep,
  });
  try {
    const pdf = await task.promise;
    const pages: TextPage[] = [];
    let offset = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const value = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
      pages.push({ page, base_offset: offset, text: value });
      offset += value.length;
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
