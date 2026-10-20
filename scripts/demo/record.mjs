// Records docs/demo.gif from the demo harness. Needs `pnpm exec vite --port 5199`
// running and ffmpeg on PATH: node scripts/demo/record.mjs
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const url = "http://127.0.0.1:5199/scripts/demo/index.html";
const out = process.argv[2] || "docs/demo.gif";
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(url);
const frame = page.frames().find((f) => f.url().endsWith("app.html"));
await frame
  .waitForSelector(".markdown, .document, article", { timeout: 10000 })
  .catch(() => {});
await page.waitForTimeout(1500);

// Fake pointer, since headless screenshots have none.
await page.evaluate(() => {
  const c = document.createElement("div");
  c.id = "cursor";
  c.innerHTML = `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7 17.5 L10.5 25.5 L14 24 L10.6 16.2 L17.5 16 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  Object.assign(c.style, {
    position: "fixed",
    left: "0",
    top: "0",
    zIndex: 99,
    pointerEvents: "none",
    filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))",
  });
  document.body.append(c);
});
let pos = { x: 980, y: 640 };
const place = (x, y) =>
  page.evaluate(
    ([x, y]) => {
      document.getElementById("cursor").style.transform =
        `translate(${x - 2}px, ${y - 2}px)`;
    },
    [x, y],
  );
await place(pos.x, pos.y);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
async function glide(x, y, ms = 600) {
  const from = { ...pos },
    steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const p = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t };
    await page.mouse.move(p.x, p.y);
    await place(p.x, p.y);
  }
  pos = { x, y };
}
const pause = (ms) => page.waitForTimeout(ms);
const box = await page.locator("iframe").boundingBox();
async function phrase(text) {
  const r = await frame.evaluate((text) => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let n; (n = walker.nextNode());) {
      const i = n.data.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + text.length);
      const rects = [...range.getClientRects()];
      const a = rects[0],
        b = rects[rects.length - 1];
      return {
        x1: a.left,
        y1: a.top + a.height / 2,
        x2: b.right,
        y2: b.top + b.height / 2,
      };
    }
    throw new Error(`not found: ${text}`);
  }, text);
  return {
    x1: r.x1 + box.x,
    y1: r.y1 + box.y,
    x2: r.x2 + box.x,
    y2: r.y2 + box.y,
  };
}
async function center(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function click(locator, ms) {
  const c = await center(locator);
  await glide(c.x, c.y, ms);
  await pause(120);
  await page.mouse.down();
  await page.mouse.up();
}

// Capture every composited frame with its timestamp.
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", {
  format: "png",
  maxWidth: 2560,
  maxHeight: 1600,
  everyNthFrame: 1,
});
// The screencast only emits on change; nudge one frame at the start.
await place(pos.x + 1, pos.y);
await pause(900);

// 1. Select a passage.
const p1 = await phrase("The best notes are arguments, not summaries");
await glide(p1.x1, p1.y1, 800);
await pause(200);
await page.mouse.down();
await glide(p1.x2, p1.y2, 700);
await page.mouse.up();
await pause(700);

// 2. Add a note, choose green, save.
await click(frame.getByRole("button", { name: "Add Note" }), 500);
await pause(250);
await frame
  .getByLabel("Annotation note")
  .pressSequentially("Lead the essay with this.", { delay: 45 });
await pause(300);
await click(frame.getByRole("button", { name: "green highlight" }), 450);
await pause(300);
await click(frame.getByRole("button", { name: "Save Note" }), 450);
await pause(700);

// 3. Open the Highlights sidebar.
await click(frame.getByRole("tab", { name: /Highlights/ }), 700);
await pause(1100);

// 4. An agent writes a highlight over MCP; it appears live.
await glide(1000, 560, 500);
await frame.evaluate(() =>
  window.agentHighlight(
    "Keeping highlights beside the document, anchored to the words themselves, means the original stays untouched while your notes survive.",
    "Strongest case for local-first notes. Worth moving up?",
    "purple",
  ),
);
await pause(1400);

// 5. Jump to it from the sidebar.
await click(
  frame.locator(".annotation-jump").filter({ hasText: "Keeping highlights" }),
  700,
);
await pause(2200);

await cdp.send("Page.stopScreencast");
await browser.close();

// Build a variable-rate GIF from the timestamped frames.
const dir = mkdtempSync(join(tmpdir(), "annoplan-demo-"));
let list = "";
frames.forEach((f, i) => {
  const file = join(dir, `${String(i).padStart(5, "0")}.png`);
  writeFileSync(file, Buffer.from(f.data, "base64"));
  const next = frames[i + 1]?.t ?? f.t + 2;
  list += `file '${file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
  if (!frames[i + 1]) list += `file '${file}'\n`;
});
writeFileSync(join(dir, "list.txt"), list);
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  join(dir, "list.txt"),
  "-vf",
  "fps=20,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  "-loop",
  "0",
  out,
]);
rmSync(dir, { recursive: true });
console.log(`${frames.length} frames → ${out}`);
