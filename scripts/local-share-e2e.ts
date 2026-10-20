/** Run after pnpm share:build and pnpm --dir share dev. All traffic is loopback. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import type { AnnotationBackend } from "../src/backend";
import type { Annotation } from "../src/types";
import { Handlers } from "../mcp/src/handlers";
import { DesktopSync, type ShareStore } from "../src/share/desktopSync";
const base = "http://127.0.0.1:8787";
const directory = await mkdtemp(join(tmpdir(), "annoplan-sharing-e2e-"));
const process = spawn(
  resolve("src-tauri/target/debug/examples/share-db-harness"),
  [join(directory, "owner.db")],
  { stdio: ["pipe", "pipe", "inherit"] },
);
let sequence = 0;
const waiting = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
createInterface({ input: process.stdout }).on("line", (line) => {
  const result = JSON.parse(line);
  const pending = waiting.get(result.id);
  waiting.delete(result.id);
  if (result.error) pending?.reject(new Error(result.error));
  else pending?.resolve(result.result);
});
function call<T = any>(command: string, args: unknown = {}): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.stdin.write(JSON.stringify({ id, command, args }) + "\n");
  });
}
const local: AnnotationBackend = {
  ownerName: () => call("ownerName"),
  setOwnerName: (name) => call("setOwnerName", { name }),
  reanchor: (id, start, end) => call("reanchor", { id, start, end }),
  documents: () => call("documents"),
  open: (path) => call("open", { path }),
  annotations: (documentId) => call("annotations", { documentId }),
  save: (annotation) => call("save", { annotation }),
  delete: (id) => call("delete", { id }),
  search: (query) => call("search", { query }),
  choose: async () => null,
};
const store: ShareStore = {
  shares: (documentId) => call("shares", { documentId }),
  saveShare: (share) => call("saveShare", { share }),
  importAnnotation: (annotation) => call("importAnnotation", { annotation }),
  remoteDelete: (id, shareId, authorId) =>
    call("remoteDelete", { id, shareId, authorId }),
  outbox: (shareId) => call("outbox", { shareId }),
  acknowledge: (shareId, id, updatedAt) =>
    call("acknowledge", { shareId, id, updatedAt }),
};
const sync = new DesktopSync(local, store);
sync.onStatus = (status) => console.log("sync:", status);
const browser = await chromium.launch({ headless: true });
const checks: string[] = [];
async function until(
  test: () => Promise<boolean>,
  label: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
async function makeAnnotation(page: Page, note: string, ordinal: number) {
  await page.evaluate(`(()=>{const ordinal=${ordinal};
  const surface=document.querySelector(".markdown,.docx-host,.pdf-page .textLayer");if(!surface)throw new Error("No rendered surface");
  const walker=document.createTreeWalker(surface,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest("[data-annotation-overlay],style,script,[aria-hidden=true]")?NodeFilter.FILTER_REJECT:node.textContent.trim().length>12?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT});
  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  const node=nodes[Math.min(ordinal,nodes.length-1)];if(!node)throw new Error("No selectable text");
  const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(node.length,24));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  surface.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
 })()`);
  await page.getByRole("dialog", { name: "Annotation", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Note", exact: true }).click();
  await page.getByRole("textbox", { name: "Annotation note" }).fill(note);
  await page.getByRole("button", { name: "Save Note", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Annotation", exact: true })
    .waitFor({ state: "hidden" });
}
try {
  const agent = new Handlers(join(directory, "owner.db"), true);
  agent.clientInfo = () => ({ name: "e2e-harness", version: "1.0" });
  for (const format of ["md", "pdf", "docx"]) {
    await local.setOwnerName!("Ada");
    const file = await sync.backend.open(
      resolve(`fixtures/attention.${format}`),
    );
    const documentId = file.document.id;
    let unsubscribe = sync.backend.subscribe!(documentId, () => {});
    const owner: Annotation = {
      id: crypto.randomUUID(),
      document_id: documentId,
      quote: "attention",
      prefix: "",
      suffix: "",
      start_offset: 0,
      end_offset: 9,
      color: "yellow",
      note: `Owner ${format}`,
      page: format === "pdf" ? 1 : null,
      rects_json: null,
      created_at: "",
      updated_at: "",
    };
    const original = await sync.backend.save(owner);
    const ownerToDelete = await sync.backend.save({
      ...owner,
      id: crypto.randomUUID(),
      note: `Owner removal ${format}`,
    });
    const share = await sync.create(file, base, "Ada", 3600);
    console.log(`Sharing ${format}: ${share.id}`);
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1366, height: 900 } }),
      browser.newContext({ viewport: { width: 1280, height: 800 } }),
    ]);
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      page.on("pageerror", (error) =>
        console.error(`browser ${format}:`, error.message),
      );
      await page.goto(share.url);
      await page
        .getByRole("textbox", { name: "Your name" })
        .fill(i === 0 ? "Sam" : "Lee");
      await page
        .getByRole("button", { name: "Open document", exact: true })
        .click();
      await page
        .locator(
          format === "md"
            ? ".markdown"
            : format === "pdf"
              ? ".textLayer"
              : ".docx-host section",
        )
        .first()
        .waitFor();
      await page.getByText(`Owner ${format}`, { exact: true }).waitFor();
    }
    const [sam, lee] = pages;
    // A real second SQLite writer must enqueue and reach encrypted browser views.
    const { annotation: agentRow } = await agent.createAnnotation({
      document_id: documentId,
      quote: "Keep the passages",
      page: format === "pdf" ? 1 : undefined,
      note: `Agent ${format} note`,
    });
    for (const page of pages) {
      const row = page
        .locator(".annotation-row")
        .filter({ hasText: `Agent ${format} note` });
      await row.waitFor({ timeout: 5000 });
      assert.equal(
        await row.locator(".author-label").textContent(),
        "Ada's agent",
      );
      assert.equal(
        await row.locator(".author-label").getAttribute("title"),
        "e2e-harness 1.0",
      );
      assert.equal(
        await row.getByRole("button", { name: "View annotation" }).count(),
        1,
      );
    }
    await local.setOwnerName!("Alex");
    await sam
      .locator(".author-label")
      .filter({ hasText: "Alex's agent" })
      .waitFor({ timeout: 5000 });
    await local.setOwnerName!("Ada");
    await sam
      .locator(".author-label")
      .filter({ hasText: "Ada's agent" })
      .waitFor({ timeout: 5000 });
    agent.updateAnnotation({
      id: agentRow.id,
      note: `Agent ${format} edited`,
      color: "purple",
    });
    await lee
      .getByText(`Agent ${format} edited`, { exact: true })
      .waitFor({ timeout: 5000 });
    agent.deleteAnnotation({ id: agentRow.id });
    await sam
      .getByText(`Agent ${format} edited`, { exact: true })
      .waitFor({ state: "hidden", timeout: 5000 });
    await makeAnnotation(sam, `Sam ${format} note`, 1);
    await lee
      .getByText(`Sam ${format} note`, { exact: true })
      .waitFor({ timeout: 3000 });
    await until(
      async () =>
        (await local.annotations(documentId)).some(
          (a) => a.note === `Sam ${format} note` && a.author_name === "Sam",
        ),
      "Sam annotation in SQLite",
      3000,
    );
    await makeAnnotation(lee, `Lee ${format} note`, 2);
    await sam
      .getByText(`Lee ${format} note`, { exact: true })
      .waitFor({ timeout: 3000 });
    await until(
      async () =>
        (await local.annotations(documentId)).some(
          (a) => a.note === `Lee ${format} note` && a.author_name === "Lee",
        ),
      "Lee annotation in SQLite",
      3000,
    );
    // Edit and delete through the same popover used by desktop.
    await sam
      .getByRole("button", { name: "Edit annotation", exact: true })
      .last()
      .click();
    await sam
      .getByRole("textbox", { name: "Annotation note" })
      .fill(`Sam ${format} edited`);
    await sam.getByRole("button", { name: "Save Note", exact: true }).click();
    await lee
      .getByText(`Sam ${format} edited`, { exact: true })
      .waitFor({ timeout: 3000 });
    const ownRow = lee
      .locator(".annotation-row")
      .filter({ hasText: `Lee ${format} note` });
    await ownRow
      .getByRole("button", { name: "Edit annotation", exact: true })
      .click();
    await lee
      .getByRole("button", { name: "Delete highlight", exact: true })
      .click();
    await sam
      .getByText(`Lee ${format} note`, { exact: true })
      .waitFor({ state: "hidden", timeout: 3000 });
    await until(
      async () =>
        !(await local.annotations(documentId)).some(
          (a) => a.note === `Lee ${format} note`,
        ),
      "recipient delete in SQLite",
      3000,
    );
    // Owner updates reach both browsers.
    await sync.backend.save({
      ...original,
      note: `Owner ${format} edited`,
      color: "green",
    });
    await sam
      .getByText(`Owner ${format} edited`, { exact: true })
      .waitFor({ timeout: 3000 });
    await lee
      .getByText(`Owner ${format} edited`, { exact: true })
      .waitFor({ timeout: 3000 });
    const denied = await sam.evaluate(
      async ({ id, owner }) => {
        const credentials = JSON.parse(localStorage.getItem(`annoplan:${id}`)!);
        const response = await fetch(`/api/shares/${id}/annotations/${owner}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ updated_at: new Date().toISOString() }),
        });
        return response.status;
      },
      { id: share.id, owner: owner.id },
    );
    assert.equal(denied, 403);
    // Close/reopen desktop subscription; browser writes while it is disconnected.
    unsubscribe();
    await sync.backend.delete(ownerToDelete.id);
    await sam
      .locator(".annotation-row")
      .filter({ hasText: `Sam ${format} edited` })
      .getByRole("button", { name: "Edit annotation", exact: true })
      .click();
    await sam
      .getByRole("textbox", { name: "Annotation note" })
      .fill(`Sam ${format} offline`);
    await sam.getByRole("button", { name: "Save Note", exact: true }).click();
    await sync.backend.save({ ...original, note: `Owner ${format} offline` });
    unsubscribe = sync.backend.subscribe!(documentId, () => {});
    await until(
      async () =>
        (await local.annotations(documentId)).some(
          (a) => a.note === `Sam ${format} offline`,
        ),
      "desktop reopen catch-up",
      5000,
    );
    await lee
      .getByText(`Owner ${format} offline`, { exact: true })
      .waitFor({ timeout: 5000 });
    await until(
      async () =>
        !(await local.annotations(documentId)).some(
          (a) => a.id === ownerToDelete.id,
        ),
      "offline owner delete persisted",
      3000,
    );
    await lee
      .getByText(`Owner removal ${format}`, { exact: true })
      .waitFor({ state: "hidden", timeout: 3000 });
    // Reload remembers name and participant token, with no join prompt.
    await lee.reload();
    await lee.getByText(`Sam ${format} offline`, { exact: true }).waitFor();
    await sam.screenshot({
      path: join(directory, `${format}.png`),
      fullPage: true,
    });
    await sync.revoke(share);
    for (const page of pages)
      await page
        .getByRole("heading", { name: "This link has expired", exact: true })
        .waitFor({ timeout: 3000 });
    const persisted = await local.annotations(documentId);
    assert(
      persisted.some(
        (a) => a.note === `Sam ${format} offline` && a.author_name === "Sam",
      ),
    );
    assert(persisted.some((a) => a.id === owner.id));
    await sam.reload();
    await sam
      .getByRole("heading", { name: "This link has expired", exact: true })
      .waitFor();
    unsubscribe();
    await Promise.all(contexts.map((c) => c.close()));
    checks.push(
      `${format}: rendering, two named recipients, live adds/edits/deletes, owner changes, MCP writes/harness/renaming, 403 permission, reconnect/outbox, remembered identity, revoke/expired page and SQLite retention passed`,
    );
    console.log("PASS", checks.at(-1));
  }
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({ checks, database: join(directory, "owner.db") }, null, 2),
  );
  console.log(`PASS: ${checks.length} formats. Artifacts: ${directory}`);
} finally {
  sync.dispose();
  await browser.close();
  process.stdin.end();
  process.kill();
}
