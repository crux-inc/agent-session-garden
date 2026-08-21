export function appearanceFor(session) {
  let hash = 2166136261;
  for (const character of `${session.agent.name}:${session.model.appearanceKey}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = Math.abs(hash) % 360;
  return { coat: `hsl(${hue} 35% 42%)`, hair: `hsl(${(hue + 35) % 360} 24% 24%)` };
}
export const ACTIVE_LIMIT = 5;
const archived = new Set(["completed", "failed"]);
export const isArchived = (status) => archived.has(status);
export const locationFor = (status) => isArchived(status) ? `${status} archive` : status === "researching" ? "bookshelf" : status === "tool_calling" ? "computer" : status === "waiting_for_permission" ? "permission desk" : status === "waiting_for_user" ? "question desk" : status.startsWith("waiting") ? "waiting area" : "desk";
export function homeSeat(sessionId) {
  let hash = 0;
  for (const character of sessionId) hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0;
  return { x: 8 + (Math.abs(hash) % 61), y: 18 + (Math.abs(hash >> 5) % 30) };
}
export function scenePosition(sessionId, status) {
  const home = homeSeat(sessionId);
  if (isArchived(status)) return { x: 24 + (Math.abs(home.x * 3) % 45), y: 72 };
  if (status === "researching") return { x: 80, y: 48 };
  if (status === "tool_calling") return { x: 76, y: 26 };
  if (status.startsWith("waiting")) return { x: 83, y: 72 };
  return home;
}
const activeSeats = [{ x: 29, y: 31 }, { x: 50, y: 31 }, { x: 71, y: 31 }, { x: 29, y: 63 }, { x: 50, y: 63 }];
export function activeSessions(sessions) {
  return sessions.filter((session) => !isArchived(session.status.primary)).sort((a, b) => b.status.changedAt.localeCompare(a.status.changedAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, ACTIVE_LIMIT);
}
export function characterViews(sessions) {
  return activeSessions(sessions).map((session, index) => ({ ...session, position: activeSeats[index], homeSeat: homeSeat(session.sessionId), location: locationFor(session.status.primary), appearance: appearanceFor(session) }));
}
export const activityLabel = (activity) => activity ? `${activity.kind} / ${activity.name ?? "unnamed"} / ${activity.state ?? "unknown"}${activity.summary ? ` / ${activity.summary}` : ""}` : "none";
export class ProjectionState {
  snapshot = { schemaVersion: 1, project: { root: "" }, sessions: [] };
  applySnapshot(snapshot) { if (snapshot.schemaVersion === 1) this.snapshot = snapshot; }
  applyUpdate(session) { if (session.schemaVersion !== 1) return; this.snapshot = { ...this.snapshot, sessions: [...this.snapshot.sessions.filter((current) => current.sessionId !== session.sessionId), session] }; }
  get current() { return this.snapshot; }
}
