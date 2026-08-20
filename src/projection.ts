import { isProjectPath } from "./project.js";

export type PrimaryStatus = "coding" | "tool_calling" | "researching" | "waiting_for_user" | "waiting_for_permission" | "waiting_for_system" | "completed" | "failed" | "unknown";
export type SessionProjection = {
  schemaVersion: 1; sessionId: string; project: { root: string }; displayName: string;
  agent: { name: string; gardenRole: "builder" | "planner" | "generic" };
  model: { provider: string; id: string; appearanceKey: string };
  status: { primary: PrimaryStatus; freshness: "fresh" | "stale"; changedAt: string };
  activity: { kind: "tool" | "message" | "permission" | "question"; name: string | null; state: "pending" | "running" | "completed" | "error" | null; summary: string | null } | null;
  lifetime: { startedAt: string; endedAt: string | null };
};

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown): string => { const parsed = new Date(typeof value === "number" ? value : String(value ?? "")); return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString(); };
export function mask(value: string | null): string | null {
  if (!value) return value;
  return value.replace(/(api[_-]?key|token|password|secret|authorization|private[_-]?key|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]").replace(/\b(sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]");
}
function role(agent: string) { return agent === "build" ? "builder" : agent === "plan" ? "planner" : "generic" as const; }
type Activity = NonNullable<SessionProjection["activity"]>;

const partsOf = (raw: any): any[] => Array.isArray(raw?.parts) ? raw.parts : raw?.part ? [raw.part] : raw && typeof raw === "object" ? [raw] : [];

const activityOf = (raw: any): Activity | null => {
  const activity = (part: any): Activity | null => {
    if (!part || typeof part !== "object") return null;
    const state = ["pending", "running", "completed", "error"].includes(part.state) ? part.state : null;
    if (part.type === "tool" || text(part.tool)) return { kind: "tool", name: text(part.tool) ? part.tool : null, state, summary: mask(text(part.summary) ? part.summary : null) };
    if (part.type === "permission") return { kind: "permission", name: text(part.name) ? part.name : null, state, summary: mask(text(part.summary) ? part.summary : null) };
    if (part.type === "question" || part.type === "input") return { kind: "question", name: text(part.name) ? part.name : null, state, summary: mask(text(part.summary) ? part.summary : null) };
    if (part.type === "text" && state === "running") return { kind: "message", name: null, state, summary: mask(text(part.text) ? part.text : null) };
    return null;
  };
  const candidates = partsOf(raw).map(activity).filter((value): value is Activity => value !== null);
  return candidates.find((value) => value.kind === "permission")
    ?? candidates.find((value) => value.kind === "question")
    ?? candidates.find((value) => value.kind === "tool" && /webfetch|search|research/i.test(value.name ?? ""))
    ?? candidates.find((value) => value.kind === "tool")
    ?? candidates.find((value) => value.kind === "message")
    ?? null;
};

const activeTool = (activity: Activity | null): boolean => activity?.kind === "tool" && (activity.state === "pending" || activity.state === "running");
const researchTool = (activity: Activity | null): boolean => activity?.kind === "tool" && (activity.state === "pending" || activity.state === "running") && /webfetch|search|research/i.test(activity.name ?? "");
const activeSignal = (value: unknown): boolean => value === true || (typeof value === "string" && /pending|running|active|generat|writing|editing|patch/i.test(value));
export function projectSession(raw: any, projectRoot: string, observed?: any, freshness: "fresh" | "stale" = "fresh", previous?: SessionProjection): SessionProjection | null {
  const id = raw?.id ?? raw?.sessionID;
  const directory = raw?.directory ?? raw?.worktree ?? raw?.project?.root;
  if (!text(id) || !text(directory) || !isProjectPath(projectRoot, directory)) return null;
  const agent = text(raw.agent) ? raw.agent : text(raw?.agent?.name) ? raw.agent.name : "unknown";
  const observedProvider = text(raw?.model?.provider) ? raw.model.provider : text(raw?.modelProvider) ? raw.modelProvider : null;
  const observedModelId = text(raw?.model?.id) ? raw.model.id : text(raw?.modelID) ? raw.modelID : null;
  const provider = observedProvider ?? "unknown";
  const modelId = observedModelId ?? "unknown";
  const currentActivity = activityOf(observed);
  const statusValue = observed?.status ?? raw?.status;
  const invalid = !text(raw?.id ?? raw?.sessionID) || !text(directory) || !observedProvider || !observedModelId || observed?.invalid === true || observed?.contradictory === true;
  let primary: PrimaryStatus = "waiting_for_system";
  if (invalid) primary = "unknown";
  else if (statusValue === "completed" || statusValue === "success") primary = "completed";
  else if (statusValue === "failed" || statusValue === "error" || observed?.error || observed?.terminalError || observed?.sessionError || observed?.terminalMessageError) primary = "failed";
  else if (observed?.permission === true || observed?.permission?.state === "pending" || (currentActivity?.kind === "permission" && currentActivity.state === "pending")) primary = "waiting_for_permission";
  else if (observed?.question === true || observed?.question?.state === "pending" || (currentActivity?.kind === "question" && currentActivity.state === "pending")) primary = "waiting_for_user";
  else if (researchTool(currentActivity)) primary = "researching";
  else if (activeTool(currentActivity)) primary = "tool_calling";
  else if (activeSignal(observed?.generating) || activeSignal(observed?.writing) || activeSignal(observed?.editing) || activeSignal(observed?.patching) || currentActivity?.kind === "message") primary = "coding";
  const stale = freshness === "stale" && previous;
  if (stale) return { ...previous, status: { ...previous.status, freshness: "stale" } };
  const changedAt = previous?.status.primary === primary ? previous.status.changedAt : new Date().toISOString();
  const startedAt = date(raw.time?.created ?? raw.createdAt ?? raw.created) || new Date().toISOString();
  const endedAt = primary === "completed" || primary === "failed" ? date(raw.time?.updated ?? raw.updatedAt ?? raw.updated) || new Date().toISOString() : null;
  return { schemaVersion: 1, sessionId: id, project: { root: projectRoot }, displayName: text(raw.title) ? raw.title : `Session ${id.slice(0, 8)}`, agent: { name: agent, gardenRole: role(agent) }, model: { provider, id: modelId, appearanceKey: `${provider.trim()}:${modelId.trim()}`.toLowerCase() }, status: { primary, freshness, changedAt }, activity: primary === "completed" || primary === "failed" || primary === "unknown" ? null : currentActivity, lifetime: { startedAt, endedAt } };
}
