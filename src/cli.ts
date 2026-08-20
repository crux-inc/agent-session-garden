#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { detectProjectRoot } from "./project.js";
import { GardenServer } from "./server.js";
import { OpenCodeAdapter } from "./opencode.js";

type Args = { port?: number; directory?: string; open: boolean; opencodeUrl?: string };

export function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let directory: string | undefined;
  let open = false;
  let opencodeUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--open") open = true;
    else if (argument === "--port") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer from 0 to 65535");
      port = value;
    } else if (argument === "--directory") directory = argv[++index];
    else if (argument === "--opencode-url") opencodeUrl = argv[++index];
    else if (argument === "--help") { console.log("Usage: agent-session-garden [--port PORT] [--directory PATH] [--opencode-url URL] [--open]"); process.exit(0); }
    else throw new Error(`Unknown option: ${argument}`);
  }
  return { port, directory, open, opencodeUrl };
}

export async function run(argv = process.argv.slice(2), output = console.log): Promise<() => Promise<void>> {
  const args = parseArgs(argv);
  const root = await detectProjectRoot(args.directory);
  const adapter = new OpenCodeAdapter({ projectRoot: root, baseUrl: args.opencodeUrl });
  try { await adapter.connect(); } catch { await adapter.startOwned(); }
  const server = new GardenServer({ projectRoot: root, port: args.port, adapter, clientFile: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "index.html") });
  await server.start();
  output(`Agent Session Garden serving ${server.url} for ${root}`);
  if (args.open) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const { spawn } = await import("node:child_process");
    spawn(command, [server.url], { detached: true, stdio: "ignore" }).unref();
  }
  return async () => { await server.stop(); await adapter.stop(); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((stop) => {
    const shutdown = () => { void stop().finally(() => process.exit(0)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
