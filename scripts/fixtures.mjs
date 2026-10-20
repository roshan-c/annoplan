import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
mkdirSync("fixtures", { recursive: true });
const title = "A field guide to paying attention";
const passage = "The most useful notes begin with a moment of attention.";
writeFileSync(
  "fixtures/attention.md",
  `# ${title}\n\n${passage}\n\n## Small observations\n\nRead slowly. **Keep the passages** that change how you see a problem. A highlight is a way of returning to an idea.\n\n> A margin is a place to think.\n\n## A practice for tomorrow\n\n1. Open a document.\n2. Select a passage and pick a colour.\n3. Add a note in your own words.\n\n### Things to notice\n\n- Repeated words: attention, attention.\n- Unicode text: café, 日本語, and 📚.\n- Inline code: \`readOnly = true\`.\n\n## Returning to an idea\n\n${passage}\n\nThis second occurrence helps exercise quote-context anchoring.\n`,
);
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica),
  bold = await pdf.embedFont(StandardFonts.HelveticaBold);
for (let i = 1; i <= 3; i++) {
  const p = pdf.addPage([612, 792]);
  p.drawText(
    i === 1 ? "A field guide to attention" : `Notes from the field - ${i}`,
    { x: 60, y: 710, size: 23, font: bold, color: rgb(0.15, 0.15, 0.15) },
  );
  const lines = [
    passage,
    "",
    "Read slowly. Keep the passages that change how you see a problem.",
    "A highlight is a way of returning to an idea.",
    "",
    "A margin is a place to think.",
    "",
    "Select this text and add a note. Your original file stays unchanged.",
  ];
  lines.forEach((line, n) =>
    p.drawText(line, { x: 60, y: 650 - n * 26, size: 13, font }),
  );
  p.drawText(`${i}`, { x: 300, y: 40, size: 10, font });
}
writeFileSync("fixtures/attention.pdf", await pdf.save());
const doc = new Document({
  sections: [
    {
      properties: {},
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
        new Paragraph(passage),
        new Paragraph({
          text: "Small observations",
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph({
          children: [
            new TextRun("Read slowly. "),
            new TextRun({ text: "Keep the passages ", bold: true }),
            new TextRun(
              "that change how you see a problem. A highlight is a way of returning to an idea.",
            ),
          ],
        }),
        new Paragraph({
          text: "A practice for tomorrow",
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph(
          "Open a document, select a passage, and add a note in your own words.",
        ),
        new Paragraph({
          text: "Returning to an idea",
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph(passage),
      ],
    },
  ],
});
writeFileSync("fixtures/attention.docx", await Packer.toBuffer(doc));
console.log("Generated Markdown, three-page PDF, and DOCX fixtures.");
