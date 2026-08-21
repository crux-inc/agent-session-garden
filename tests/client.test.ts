import test from "node:test";
import assert from "node:assert/strict";
import { activityLabel, appearanceFor, archiveSessions, characterViews, homeSeat, locationFor, ProjectionState, roleForAgent, scenePosition, ARCHIVE_LIMIT } from "../client/projection.js";
import type { SessionProjection } from "../src/projection.js";

const session = (id: string, status: SessionProjection["status"]["primary"] = "coding"): SessionProjection => ({
  schemaVersion: 1, sessionId: id, project: { root: "/tmp/project" }, displayName: id,
  agent: { name: "build", gardenRole: "builder" }, model: { provider: "Anthropic", id: "Claude", appearanceKey: "anthropic:claude" },
  status: { primary: status, freshness: "fresh", changedAt: "2026-08-20T00:00:00.000Z" }, activity: null,
  lifetime: { startedAt: "2026-08-20T00:00:00.000Z", endedAt: null }
});

test("maps known and unknown agents to closed garden roles", () => {
  assert.equal(roleForAgent("build"), "builder");
  assert.equal(roleForAgent("plan"), "planner");
  assert.equal(roleForAgent("review"), "generic");
});

test("derives stable appearance and home seat from complete identity", () => {
  assert.deepEqual(appearanceFor(session("a")), appearanceFor(session("b")));
  assert.deepEqual(homeSeat("stable"), homeSeat("stable"));
  assert.notDeepEqual(homeSeat("stable"), homeSeat("different"));
});

test("maps status to office location while retaining home-based position", () => {
  assert.equal(locationFor("researching"), "bookshelf");
  assert.equal(locationFor("tool_calling"), "computer");
  assert.equal(locationFor("waiting_for_permission"), "waiting area");
  assert.equal(locationFor("completed"), "completed archive");
  assert.equal(characterViews([session("one", "researching")])[0]?.location, "bookshelf");
  assert.deepEqual(characterViews([session("one", "researching")])[0]?.homeSeat, homeSeat("one"));
  assert.notDeepEqual(scenePosition("one", "researching"), homeSeat("one"));
});

test("applies a complete snapshot and replaces matching projection updates", () => {
  const state = new ProjectionState();
  state.applySnapshot({ schemaVersion: 1, project: { root: "/tmp/project" }, sessions: [session("one"), session("two")] });
  state.applyUpdate(session("one", "waiting_for_user"));
  assert.deepEqual(state.current.sessions.map((item) => [item.sessionId, item.status.primary]), [["two", "coding"], ["one", "waiting_for_user"]]);
});

test("keeps completed and failed archives separate and bounded to recent sessions", () => {
  const sessions = Array.from({ length: ARCHIVE_LIMIT + 2 }, (_, index) => session(`completed-${index}`, "completed" as const)).map((item, index) => ({ ...item, status: { ...item.status, changedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` } }));
  const failed = session("failed", "failed");
  assert.equal(archiveSessions([...sessions, failed], "completed").length, ARCHIVE_LIMIT);
  assert.equal(archiveSessions([...sessions, failed], "completed").some((item) => item.sessionId === "failed"), false);
  assert.deepEqual(archiveSessions([...sessions, failed], "failed").map((item) => item.sessionId), ["failed"]);
});

test("formats activity detail for the browser panel", () => {
  assert.equal(activityLabel({ kind: "tool", name: "Bash", state: "running", summary: "command" }), "tool / Bash / running / command");
  assert.equal(activityLabel(null), "none");
});
