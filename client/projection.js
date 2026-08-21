export function appearanceFor(session) {
  let hash = 2166136261;
  for (const character of `${session.agent.name}:${session.model.appearanceKey}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = Math.abs(hash) % 360;
  return { coat: `hsl(${hue} 35% 42%)`, hair: `hsl(${(hue + 35) % 360} 24% 24%)` };
}
const archived = new Set(["completed", "failed"]);
export const isArchived = (status) => archived.has(status);
export const locationFor = (status) => isArchived(status) ? `${status} archive` : status === "researching" ? "bookshelf" : status === "tool_calling" ? "computer" : status.startsWith("waiting") ? "waiting area" : "desk";
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
export function characterViews(sessions) {
  return sessions.map((session) => ({ ...session, position: scenePosition(session.sessionId, session.status.primary), homeSeat: homeSeat(session.sessionId), location: locationFor(session.status.primary), appearance: appearanceFor(session) }));
}
export const activityLabel = (activity) => activity ? `${activity.kind} / ${activity.name ?? "unnamed"} / ${activity.state ?? "unknown"}${activity.summary ? ` / ${activity.summary}` : ""}` : "none";
export class ProjectionState {
  snapshot = { schemaVersion: 1, project: { root: "" }, sessions: [] };
  applySnapshot(snapshot) { if (snapshot.schemaVersion === 1) this.snapshot = snapshot; }
  applyUpdate(session) { if (session.schemaVersion !== 1) return; this.snapshot = { ...this.snapshot, sessions: [...this.snapshot.sessions.filter((current) => current.sessionId !== session.sessionId), session] }; }
  get current() { return this.snapshot; }
}
