import { Document, Packer, Paragraph, ImageRun } from "docx";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { extractText } from "../src/text.js";
import { fixture } from "./fixture.js";
import { Handlers } from "../src/handlers.js";

it("extracts PDF.js page text with cumulative UTF-16 offsets and scopes quotes by page", async () => {
  const path = fileURLToPath(
    new URL("../../fixtures/attention.pdf", import.meta.url),
  );
  const pages = await extractText(path, "pdf");
  expect(pages).toHaveLength(3);
  expect(pages[0]).toMatchObject({ page: 1, base_offset: 0 });
  expect(pages[1].base_offset).toBe(pages[0].text.length);
  expect(pages[0].text).toContain(
    "The most useful notes begin with a moment of attention.",
  );
  const data = fixture(4);
  data.db.prepare("UPDATE documents SET path=? WHERE id='pdf'").run(path);
  const handlers = new Handlers(data.path, true);
  try {
    const quote = "The most useful notes begin with a moment of attention.";
    await expect(
      handlers.createAnnotation({ document_id: "pdf", quote }),
    ).rejects.toThrow("Ambiguous");
    const { annotation } = await handlers.createAnnotation({
      document_id: "pdf",
      quote,
      page: 2,
    });
    expect(annotation.page).toBe(2);
    expect(annotation.start_offset).toBeGreaterThanOrEqual(
      pages[1].base_offset,
    );
    const text = await handlers.getDocumentText({
      document_id: "pdf",
      page: 2,
      limit: 20,
    });
    expect(text).toMatchObject({
      page: 2,
      page_count: 3,
      base_offset: pages[1].base_offset,
      text: "Notes from the field",
    });
    await expect(
      handlers.createAnnotation({ document_id: "pdf", quote, page: 99 }),
    ).rejects.toThrow("Quote not found");
  } finally {
    data.close();
  }
});

it("uses docx-preview body text without adding artificial block separators", async () => {
  const pages = await extractText(
    fileURLToPath(new URL("../../fixtures/attention.docx", import.meta.url)),
    "docx",
  );
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ page: null, base_offset: 0 });
  expect(pages[0].text).toContain("attentionThe most useful notes");
  expect(pages[0].text).toContain("Small observationsRead slowly.");
  expect(pages[0].text).not.toContain(".docx-wrapper");
});

it("extracts DOCX text around embedded images without requiring browser asset loading", async () => {
  const data = fixture(4);
  try {
    const image = new ImageRun({
      type: "png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXcAAAAASUVORK5CYII=",
        "base64",
      ),
      transformation: { width: 1, height: 1 },
    });
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ children: [image] }),
              new Paragraph("After image 🌍"),
            ],
          },
        ],
      }),
    );
    const path = join(data.dir, "image.docx");
    writeFileSync(path, bytes);
    expect((await extractText(path, "docx"))[0].text).toBe("After image 🌍");
  } finally {
    data.close();
  }
});
