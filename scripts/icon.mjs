import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(
  "/tmp/annoplan-icon.png",
  new Resvg(readFileSync("assets/icon.svg"), {
    fitTo: { mode: "width", value: 1024 },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng(),
);
