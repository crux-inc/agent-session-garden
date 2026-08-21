export type PrimaryStatus = "coding" | "tool_calling" | "researching" | "waiting_for_user" | "waiting_for_permission" | "waiting_for_system" | "completed" | "failed" | "unknown";
export type GardenRole = "builder" | "planner" | "generic";
export type SessionProjection = {
  schemaVersion: 1;
  sessionId: string;
  project: { root: string };
  displayName: string;
  agent: { name: string; gardenRole: GardenRole };
  model: { provider: string; id: string; appearanceKey: string };
  status: { primary: PrimaryStatus; freshness: "fresh" | "stale"; changedAt: string };
  activity: { kind: "tool" | "message" | "permission" | "question"; name: string | null; state: "pending" | "running" | "completed" | "error" | null; summary: string | null } | null;
  lifetime: { startedAt: string; endedAt: string | null };
};
export type ProjectionSnapshot = { schemaVersion: 1; project: { root: string }; sessions: SessionProjection[] };
export const ARCHIVE_LIMIT = 12;
export const ACTIVE_LIMIT = 5;

export const roleForAgent = (agent: string): GardenRole => agent === "build" ? "builder" : agent === "plan" ? "planner" : "generic";

export function appearanceFor(session: Pick<SessionProjection, "agent" | "model">): { coat: string; hair: string } {
  let hash = 2166136261;
  for (const character of `${session.agent.name}:${session.model.appearanceKey}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = Math.abs(hash) % 360;
  return { coat: `hsl(${hue} 35% 42%)`, hair: `hsl(${(hue + 35) % 360} 24% 24%)` };
}

const ARCHIVED = new Set<PrimaryStatus>(["completed", "failed"]);
export const isArchived = (status: PrimaryStatus): boolean => ARCHIVED.has(status);
export const locationFor = (status: PrimaryStatus): string => isArchived(status) ? `${status} archive` : status === "researching" ? "bookshelf" : status === "tool_calling" ? "computer" : status === "waiting_for_permission" ? "permission desk" : status === "waiting_for_user" ? "question desk" : status.startsWith("waiting") ? "waiting area" : "desk";

export function homeSeat(sessionId: string): { x: number; y: number } {
  let hash = 0;
  for (const character of sessionId) hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0;
  return { x: 8 + (Math.abs(hash) % 61), y: 18 + (Math.abs(hash >> 5) % 30) };
}

export function scenePosition(sessionId: string, status: PrimaryStatus): { x: number; y: number } {
  const home = homeSeat(sessionId);
  if (isArchived(status)) return { x: 24 + (Math.abs(home.x * 3) % 45), y: 72 };
  if (status === "researching") return { x: 80, y: 48 };
  if (status === "tool_calling") return { x: 76, y: 26 };
  if (status === "waiting_for_permission") return { x: 83, y: 65 };
  if (status === "waiting_for_user") return { x: 83, y: 82 };
  return home;
}

export type CharacterView = SessionProjection & { position: { x: number; y: number }; homeSeat: { x: number; y: number }; location: string; appearance: { coat: string; hair: string } };
export const activityLabel = (activity: SessionProjection["activity"]): string => activity ? `${activity.kind} / ${activity.name ?? "unnamed"} / ${activity.state ?? "unknown"}${activity.summary ? ` / ${activity.summary}` : ""}` : "none";
const ACTIVE_SEATS = [{ x: 29, y: 31 }, { x: 50, y: 31 }, { x: 71, y: 31 }, { x: 29, y: 63 }, { x: 50, y: 63 }];
export function activeSessions(sessions: SessionProjection[]): SessionProjection[] {
  return sessions.filter((session) => !isArchived(session.status.primary)).sort((a, b) => b.status.changedAt.localeCompare(a.status.changedAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, ACTIVE_LIMIT);
}
export function characterViews(sessions: SessionProjection[]): CharacterView[] {
  return activeSessions(sessions).map((session, index) => ({ ...session, position: ACTIVE_SEATS[index]!, homeSeat: homeSeat(session.sessionId), location: locationFor(session.status.primary), appearance: appearanceFor(session) }));
}

export function archiveSessions(sessions: SessionProjection[], status: "completed" | "failed"): SessionProjection[] {
  return sessions.filter((session) => session.status.primary === status).sort((a, b) => b.status.changedAt.localeCompare(a.status.changedAt)).slice(0, ARCHIVE_LIMIT);
}

export class ProjectionState {
  private snapshot: ProjectionSnapshot = { schemaVersion: 1, project: { root: "" }, sessions: [] };
  applySnapshot(snapshot: ProjectionSnapshot): void { if (snapshot.schemaVersion === 1) this.snapshot = snapshot; }
  applyUpdate(session: SessionProjection): void {
    if (session.schemaVersion !== 1) return;
    const sessions = this.snapshot.sessions.filter((current) => current.sessionId !== session.sessionId);
    this.snapshot = { ...this.snapshot, sessions: [...sessions, session] };
  }
  get current(): ProjectionSnapshot { return this.snapshot; }
}
