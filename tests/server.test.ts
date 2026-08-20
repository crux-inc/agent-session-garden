import test from "node:test";
import assert from "node:assert/strict";
import { GardenServer } from "../src/server.js";
import type { SessionProjection } from "../src/projection.js";

const session: SessionProjection = {
  schemaVersion: 1, sessionId: "session-123456789", project: { root: "/tmp/project" }, displayName: "Build garden",
  agent: { name: "build", gardenRole: "builder" }, model: { provider: "Anthropic", id: "Claude", appearanceKey: "anthropic:claude" },
  status: { primary: "coding", freshness: "fresh", changedAt: "2026-08-20T00:00:00.000Z" }, activity: { kind: "tool", name: "Bash", state: "completed", summary: "password=[REDACTED]" },
  lifetime: { startedAt: "2026-08-20T00:00:00.000Z", endedAt: null }, rawContent: { input: "password=secret", output: "sk-secret" }
};

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

test("publishes complete session projection updates over SSE", async () => {
  const adapter = { snapshot: [session] } as never;
  const server = new GardenServer({ projectRoot: "/tmp/project", adapter });
  await server.start();
  try {
    const stream = await fetch(`${server.url}/api/events`);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    await reader.read();
    server.publishUpdate({ ...session, status: { ...session.status, primary: "waiting_for_user" } });
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: update/);
    assert.match(text, /waiting_for_user/);
    await reader.cancel();
  } finally { await server.stop(); }
});

test("session detail is masked and raw content requires an explicit expansion request", async () => {
  const adapter = { snapshot: [session] } as never;
  const server = new GardenServer({ projectRoot: "/tmp/project", adapter });
  await server.start();
  try {
    const list = await fetch(`${server.url}/api/sessions`).then((response) => response.json());
    assert.equal(JSON.stringify(list).includes("password=secret"), false);
    assert.equal(JSON.stringify(list).includes("sk-secret"), false);
    const detail = await fetch(`${server.url}/api/sessions/${session.sessionId}/content`).then((response) => response.json());
    assert.deepEqual(detail, { input: "password=[REDACTED]", output: "[REDACTED]" });
  } finally { await server.stop(); }
});
