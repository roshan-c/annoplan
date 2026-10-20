import { cpSync, mkdirSync } from "node:fs";
mkdirSync("public/pdf", { recursive: true });
for (const name of ["cmaps", "standard_fonts", "wasm"])
  cpSync(`node_modules/pdfjs-dist/${name}`, `public/pdf/${name}`, {
    recursive: true,
  });
