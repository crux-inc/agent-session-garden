import test from "node:test";
import assert from "node:assert/strict";
import { GardenServer } from "../src/server.js";

test("selects an available loopback port and reports health", async () => {
  const server = new GardenServer({ projectRoot: "/tmp/project" });
  await server.start();
  try {
    assert.notEqual(server.port, 0);
    assert.equal(new URL(server.url).hostname, "127.0.0.1");
    const response = await fetch(`${server.url}/api/health`);
    assert.deepEqual(await response.json(), { ready: true, server: "ready", reconciliation: "disconnected", adapter: "disconnected" });
  } finally { await server.stop(); }
});

test("an occupied explicit port fails without selecting another port", async () => {
  const first = new GardenServer({ projectRoot: "/tmp/project", port: 0 });
  await first.start();
  const second = new GardenServer({ projectRoot: "/tmp/project", port: first.port });
  try { await assert.rejects(second.start(), /EADDRINUSE/); } finally { await first.stop(); }
});

test("shutdown releases a Garden-owned server", async () => {
  const server = new GardenServer({ projectRoot: "/tmp/project" });
  await server.start();
  const url = server.url;
  await server.stop();
  await assert.rejects(fetch(`${url}/api/health`));
});
