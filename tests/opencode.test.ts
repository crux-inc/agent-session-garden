import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OpenCodeAdapter } from "../src/opencode.js";
import { projectSession, mask } from "../src/projection.js";

const projectRoot = process.cwd();
const validSession = {
  id: "session-123456789",
  directory: projectRoot,
  title: "Implement observer",
  agent: "build",
  model: { provider: "Anthropic", id: "Claude-Sonnet" },
  status: "idle",
  createdAt: "2026-08-20T00:00:00.000Z"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("projects valid OpenCode sessions into Garden protocol shape", () => {
  const projection = projectSession(validSession, projectRoot, { part: { type: "tool", tool: "WebFetch", state: "running", summary: "token=secret-value" } });
  assert.equal(projection?.sessionId, "session-123456789");
  assert.equal(projection?.agent.gardenRole, "builder");
  assert.equal(projection?.model.appearanceKey, "anthropic:claude-sonnet");
  assert.equal(projection?.status.primary, "researching");
  assert.deepEqual(projection?.activity, { kind: "tool", name: "WebFetch", state: "running", summary: "token=[REDACTED]" });
});

test("excludes sessions outside the launch project", () => {
  assert.equal(projectSession({ ...validSession, directory: `${projectRoot}-other` }, projectRoot), null);
});

test("status policy preserves terminal status over transient activity", () => {
  const projection = projectSession({ ...validSession, status: "failed" }, projectRoot, { part: { type: "tool", tool: "Bash", state: "running" } });
  assert.equal(projection?.status.primary, "failed");
  assert.equal(projection?.activity, null);
});

test("applies complete deterministic status precedence", () => {
  const cases: Array<[string, any, string]> = [
    ["permission wins over question and tools", { permission: true, question: true, parts: [{ type: "tool", tool: "Bash", state: "running" }] }, "waiting_for_permission"],
    ["question wins over tools", { question: true, parts: [{ type: "tool", tool: "Bash", state: "running" }] }, "waiting_for_user"],
    ["generation is coding", { generating: "running" }, "coding"],
    ["no active work waits for system", {}, "waiting_for_system"],
    ["invalid observations are unknown", { invalid: true }, "unknown"]
  ];
  for (const [, observed, expected] of cases) assert.equal(projectSession(validSession, projectRoot, observed)?.status.primary, expected);
});

test("selects research detail before generic tools and retains tool errors without failing", () => {
  const projection = projectSession(validSession, projectRoot, { parts: [
    { type: "tool", tool: "Bash", state: "error", summary: "token=secret" },
    { type: "tool", tool: "WebFetch", state: "running", summary: "url=https://example.test" }
  ] });
  assert.equal(projection?.status.primary, "researching");
  assert.deepEqual(projection?.activity, { kind: "tool", name: "WebFetch", state: "running", summary: "url=https://example.test" });
  assert.equal(projectSession(validSession, projectRoot, { part: { type: "tool", tool: "Bash", state: "error" } })?.status.primary, "waiting_for_system");
});

test("preserves stale freshness and activity independently of primary status", () => {
  const fresh = projectSession(validSession, projectRoot, { part: { type: "tool", tool: "Bash", state: "running" } });
  const stale = projectSession(validSession, projectRoot, { invalid: true }, "stale", fresh ?? undefined);
  assert.equal(stale?.status.freshness, "stale");
  assert.equal(stale?.status.primary, "tool_calling");
  assert.deepEqual(stale?.activity, fresh?.activity);
});

test("masks common credential-shaped summaries", () => {
  assert.equal(mask("password=hunter2 and sk-abc123"), "password=[REDACTED] and [REDACTED]");
  assert.equal(mask('AWS_ACCESS_KEY_ID="abc" private_key=-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----'), 'AWS_ACCESS_KEY_ID=[REDACTED] private_key=[REDACTED PRIVATE KEY]');
});

test("keeps raw activity out of the default projection while retaining it for explicit expansion", () => {
  const projection = projectSession(validSession, projectRoot, {
    part: { type: "tool", tool: "Bash", state: "completed", summary: "password=secret", input: "TOKEN=sk-secret", output: "done" }
  });
  assert.equal(JSON.stringify(projection).includes("sk-secret"), true);
  assert.deepEqual(projection?.rawContent, { input: "TOKEN=sk-secret", output: "done" });
});

test("adapter checks health version and reconciles inventory", async () => {
  const seen: string[] = [];
  const adapter = new OpenCodeAdapter({
    projectRoot,
    baseUrl: "http://opencode.test",
    fetch: async (url) => {
      seen.push(String(url));
      if (String(url).endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.18.18" });
      if (String(url).endsWith("/doc")) return jsonResponse({});
      if (String(url).endsWith("/session")) return jsonResponse([validSession, { ...validSession, id: "outside", directory: "/tmp/outside" }]);
      return jsonResponse({}, 404);
    }
  });
  await adapter.connect();
  assert.deepEqual(seen, ["http://opencode.test/global/health", "http://opencode.test/doc", "http://opencode.test/session"]);
  assert.equal(adapter.snapshot.length, 1);
  assert.equal(adapter.snapshot[0]?.displayName, "Implement observer");
});

test("adapter rejects unsupported OpenCode versions explicitly", async () => {
  const adapter = new OpenCodeAdapter({ projectRoot, fetch: async () => jsonResponse({ healthy: true, version: "1.19.0" }) });
  await assert.rejects(adapter.connect(), /observed 1\.19\.0; supported 1\.18\.x/);
});

test("parse failures trigger reconciliation and retain stale projections if reconciliation fails", async () => {
  let fail = false;
  const adapter = new OpenCodeAdapter({
    projectRoot,
    fetch: async (url) => {
      if (String(url).endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.18.18" });
      if (String(url).endsWith("/doc")) return jsonResponse({});
      if (String(url).endsWith("/session") && !fail) return jsonResponse([validSession]);
      return jsonResponse({}, 500);
    }
  });
  await adapter.connect();
  fail = true;
  await adapter.consumeEvent("not json");
  assert.equal(adapter.snapshot[0]?.status.freshness, "stale");
  assert.equal(adapter.snapshot[0]?.status.primary, "waiting_for_system");
});

test("owned OpenCode shutdown only kills the child process it started", async () => {
  const killed: string[] = [];
  const adapter = new OpenCodeAdapter({
    projectRoot,
    spawn: ((command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      assert.equal(command, "fake-opencode");
      assert.deepEqual(args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
      child.kill = () => { killed.push("owned"); };
      return child;
    }) as never
  });
  await adapter.stop();
  await adapter.startOwned("fake-opencode");
  assert.equal(adapter.owned, true);
  await adapter.stop();
  assert.deepEqual(killed, ["owned"]);
});
