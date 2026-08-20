import { isProjectPath } from "./project.js";

export type PrimaryStatus = "coding" | "tool_calling" | "researching" | "waiting_for_user" | "waiting_for_permission" | "waiting_for_system" | "completed" | "failed" | "unknown";
export type RawContent = { input: string | null; output: string | null };
export type SessionProjection = {
  schemaVersion: 1; sessionId: string; project: { root: string }; displayName: string;
  agent: { name: string; gardenRole: "builder" | "planner" | "generic" };
  model: { provider: string; id: string; appearanceKey: string };
  status: { primary: PrimaryStatus; freshness: "fresh" | "stale"; changedAt: string };
  activity: { kind: "tool" | "message" | "permission" | "question"; name: string | null; state: "pending" | "running" | "completed" | "error" | null; summary: string | null } | null;
  lifetime: { startedAt: string; endedAt: string | null };
  rawContent?: RawContent | null;
};

export function rawContentOf(raw: any): RawContent | null {
  const part = raw?.part ?? raw;
  if (!part || typeof part !== "object") return null;
  const input = typeof part.input === "string" ? part.input : typeof part.arguments === "string" ? part.arguments : null;
  const output = typeof part.output === "string" ? part.output : typeof part.result === "string" ? part.result : null;
  return input || output ? { input, output } : null;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown): string => { const parsed = new Date(typeof value === "number" ? value : String(value ?? "")); return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString(); };
export function mask(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/("?(?:private[_-]?key|privatekey)"?)\s*[:=]\s*-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "$1=[REDACTED PRIVATE KEY]")
    .replace(/(private[_-]?key)\s*=\s*-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "$1=[REDACTED PRIVATE KEY]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/("?(?:api[_-]?key|token|password|secret|authorization|credential|aws_access_key_id|aws_secret_access_key|access_key|client_secret)"?)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1=[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]");
}
function role(agent: string) { return agent === "build" ? "builder" : agent === "plan" ? "planner" : "generic" as const; }
function activityOf(raw: any) {
  const part = raw?.part ?? raw;
  if (!part || typeof part !== "object") return null;
  const state = ["pending", "running", "completed", "error"].includes(part.state) ? part.state : null;
  if (part.type === "tool" || text(part.tool)) return { kind: "tool" as const, name: text(part.tool) ? part.tool : null, state, summary: mask(text(part.summary) ? part.summary : null) };
  if (part.type === "permission") return { kind: "permission" as const, name: text(part.name) ? part.name : null, state, summary: mask(text(part.summary) ? part.summary : null) };
  if (part.type === "question" || part.type === "input") return { kind: "question" as const, name: text(part.name) ? part.name : null, state, summary: mask(text(part.summary) ? part.summary : null) };
  if (part.type === "text" && state === "running") return { kind: "message" as const, name: null, state, summary: mask(text(part.text) ? part.text : null) };
  return null;
}
export function projectSession(raw: any, projectRoot: string, observed?: any, freshness: "fresh" | "stale" = "fresh", previous?: SessionProjection): SessionProjection | null {
  const id = raw?.id ?? raw?.sessionID;
  const directory = raw?.directory ?? raw?.worktree ?? raw?.project?.root;
  if (!text(id) || !text(directory) || !isProjectPath(projectRoot, directory)) return null;
  const agent = text(raw.agent) ? raw.agent : text(raw?.agent?.name) ? raw.agent.name : "unknown";
  const provider = text(raw?.model?.provider) ? raw.model.provider : text(raw?.modelProvider) ? raw.modelProvider : "unknown";
  const modelId = text(raw?.model?.id) ? raw.model.id : text(raw?.modelID) ? raw.modelID : "unknown";
  const currentActivity = activityOf(observed);
  const rawContent = rawContentOf(observed);
  const statusValue = observed?.status ?? raw?.status;
  let primary: PrimaryStatus = "waiting_for_system";
  if (!text(provider) || !text(modelId)) primary = "unknown";
  else if (statusValue === "completed" || statusValue === "success") primary = "completed";
  else if (statusValue === "failed" || statusValue === "error" || observed?.error) primary = "failed";
  else if (observed?.permission) primary = "waiting_for_permission";
  else if (observed?.question) primary = "waiting_for_user";
  else if (currentActivity?.kind === "tool" && currentActivity.state === "running" && /webfetch|search|research/i.test(currentActivity.name ?? "")) primary = "researching";
  else if (currentActivity?.kind === "tool" && (currentActivity.state === "pending" || currentActivity.state === "running")) primary = "tool_calling";
  else if (observed?.generating || observed?.writing) primary = "coding";
  const changedAt = previous?.status.primary === primary ? previous.status.changedAt : new Date().toISOString();
  const startedAt = date(raw.time?.created ?? raw.createdAt ?? raw.created) || new Date().toISOString();
  const endedAt = primary === "completed" || primary === "failed" ? date(raw.time?.updated ?? raw.updatedAt ?? raw.updated) || new Date().toISOString() : null;
  return { schemaVersion: 1, sessionId: id, project: { root: projectRoot }, displayName: text(raw.title) ? raw.title : `Session ${id.slice(0, 8)}`, agent: { name: agent, gardenRole: role(agent) }, model: { provider, id: modelId, appearanceKey: `${provider}:${modelId}`.toLowerCase() }, status: { primary, freshness, changedAt }, activity: primary === "completed" || primary === "failed" ? null : currentActivity, lifetime: { startedAt, endedAt }, rawContent };
}
