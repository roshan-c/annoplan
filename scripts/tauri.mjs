// Runs the Tauri CLI, allowing the configured share host in the app CSP.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const args = process.argv.slice(2);
const base = process.env.VITE_SHARE_BASE_URL;
if (base && ["dev", "build"].includes(args[0])) {
  const { origin, protocol } = new URL(base);
  const socket = origin.replace(/^http/, "ws");
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const csp = conf.app.security.csp.replace(
    "connect-src 'self'",
    `connect-src 'self' ${origin} ${socket}`,
  );
  if (
    protocol !== "https:" &&
    !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base)
  )
    console.warn(`warning: share host ${origin} is not HTTPS`);
  args.push("--config", JSON.stringify({ app: { security: { csp } } }));
}
const result = spawnSync("tauri", args, { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
