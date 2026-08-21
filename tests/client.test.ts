import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_LIMIT, activeSessions, activityLabel, appearanceFor, archiveSessions, characterViews, homeSeat, locationFor, ProjectionState, roleForAgent, scenePosition, ARCHIVE_LIMIT } from "../client/projection.js";
import type { SessionProjection } from "../src/projection.js";

const session = (id: string, status: SessionProjection["status"]["primary"] = "coding"): SessionProjection => ({
  schemaVersion: 1, sessionId: id, project: { root: "/tmp/project" }, displayName: id,
  agent: { name: "build", gardenRole: "builder" }, model: { provider: "Anthropic", id: "Claude", appearanceKey: "anthropic:claude" },
  status: { primary: status, freshness: "fresh", changedAt: "2026-08-20T00:00:00.000Z" }, activity: null,
  lifetime: { startedAt: "2026-08-20T00:00:00.000Z", endedAt: null }
});
const changedAt = (item: SessionProjection, value: string): SessionProjection => ({ ...item, status: { ...item.status, changedAt: value } });

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

test("maps status to office location while retaining home seat metadata", () => {
  assert.equal(locationFor("researching"), "bookshelf");
  assert.equal(locationFor("tool_calling"), "computer");
  assert.equal(locationFor("waiting_for_permission"), "permission desk");
  assert.equal(locationFor("waiting_for_user"), "question desk");
  assert.equal(locationFor("completed"), "completed archive");
  assert.equal(characterViews([session("one", "researching")])[0]?.location, "bookshelf");
  assert.deepEqual(characterViews([session("one", "researching")])[0]?.homeSeat, homeSeat("one"));
  assert.notDeepEqual(characterViews([session("one", "researching")])[0]?.position, homeSeat("one"));
});

test("filters, ranks, ties, and bounds active floor sessions", () => {
  const sessions = [
    changedAt(session("z", "unknown"), "2026-08-20T03:00:00.000Z"),
    changedAt(session("b"), "2026-08-20T02:00:00.000Z"),
    changedAt(session("a"), "2026-08-20T02:00:00.000Z"),
    changedAt(session("completed", "completed"), "2026-08-20T04:00:00.000Z"),
    ...Array.from({ length: 5 }, (_, index) => changedAt(session(`extra-${index}`), "2026-08-20T01:00:00.000Z")),
  ];
  assert.deepEqual(activeSessions(sessions).map((item) => item.sessionId), ["z", "a", "b", "extra-0", "extra-1"]);
  assert.equal(characterViews(sessions).length, ACTIVE_LIMIT);
});

test("assigns visible characters to fixed row-major seats and retains status labels", () => {
  const views = characterViews([session("one", "waiting_for_permission"), session("two", "researching")]);
  assert.deepEqual(views.map((view) => view.position), [{ x: 29, y: 31 }, { x: 50, y: 31 }]);
  assert.deepEqual(views.map((view) => view.location), ["permission desk", "bookshelf"]);
});

test("applies a complete snapshot and replaces matching projection updates", () => {
  const state = new ProjectionState();
  state.applySnapshot({ schemaVersion: 1, project: { root: "/tmp/project" }, sessions: [session("one"), session("two")] });
  state.applyUpdate(session("one", "waiting_for_user"));
  assert.deepEqual(state.current.sessions.map((item) => [item.sessionId, item.status.primary]), [["two", "coding"], ["one", "waiting_for_user"]]);
});

test("updates ranking immediately while retaining the complete projection", () => {
  const state = new ProjectionState();
  state.applySnapshot({ schemaVersion: 1, project: { root: "/tmp/project" }, sessions: [session("one"), session("two")] });
  state.applyUpdate(changedAt(session("three"), "2026-08-21T00:00:00.000Z"));
  assert.deepEqual(characterViews(state.current.sessions).map((item) => item.sessionId), ["three", "one", "two"]);
  assert.equal(state.current.sessions.length, 3);
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
