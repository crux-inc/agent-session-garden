import { spawn, type ChildProcess } from "node:child_process";
import type { SessionProjection } from "./projection.js";
import { mask, projectSession, terminalMessageErrorOf } from "./projection.js";

export type FetchLike = typeof fetch;
export type OperationalState = "connected" | "reconnecting" | "stale" | "unsupported_version";
export type SseFrame = { type: string; properties?: unknown; id?: string };
export type SseSource = (url: string, signal: AbortSignal) => Promise<AsyncIterable<SseFrame>>;
export type OpenCodeOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
  sse?: SseSource;
  projectRoot: string;
  spawn?: typeof spawn;
  logger?: (message: string) => void;
  onProjectionUpdate?: (snapshot: SessionProjection[]) => void;
  onOperationalState?: (state: OperationalState, message?: string) => void;
  autoStartOwned?: boolean;
  retry?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    slowDelayMs?: number;
    rapidFailureLimit?: number;
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  };
};

const EVENT_TYPES = new Set([
  "session.created", "session.updated", "session.deleted", "session.status",
  "message.updated", "message.removed", "message.part.updated", "message.part.removed",
  "permission.asked", "permission.replied", "question.asked", "question.replied",
  "input.asked", "input.replied", "session.error"
]);

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function nativeSseSource(request: FetchLike = fetch): SseSource {
  return async (url, signal) => {
    const response = await request(`${url}/event`, { headers: { Accept: "text/event-stream" }, signal });
    if (!response.ok) throw new Error(`OpenCode SSE failed with HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) throw new Error("OpenCode SSE returned an invalid content type");
    if (!response.body) throw new Error("OpenCode SSE returned an empty body");
    return parseSse(response.body.getReader());
  };
}

async function* parseSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? "";
      for (const record of records) {
        const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) {
          if (record.split(/\r?\n/).every((line) => line.trim() === "" || line.startsWith(":"))) continue;
          throw new Error("OpenCode SSE frame has no data");
        }
        const event = JSON.parse(data) as SseFrame;
        if (!event || typeof event.type !== "string") throw new Error("OpenCode SSE frame has an invalid event type");
        yield event;
      }
      if (result.done) {
        if (buffer.trim()) throw new Error("OpenCode SSE ended with an incomplete frame");
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class OpenCodeAdapter {
  baseUrl: string;
  private readonly request: FetchLike;
  private readonly source?: SseSource;
  private readonly projectRoot: string;
  private readonly log: (message: string) => void;
  private readonly launch: typeof spawn;
  private readonly update?: (snapshot: SessionProjection[]) => void;
  private readonly stateUpdate?: (state: OperationalState, message?: string) => void;
  private readonly autoStartOwned: boolean;
  private readonly retry: Required<NonNullable<OpenCodeOptions["retry"]>>;
  private readonly explicitBaseUrl: boolean;
  private child: ChildProcess | null = null;
  private streamAbort: AbortController | null = null;
  private observation: Promise<void> | null = null;
  private stopped = false;
  private refreshing = false;
  private refreshPending = false;
  private refreshSequence = 0;
  private projections = new Map<string, SessionProjection>();
  private sessionErrors = new Set<string>();
  private readonly pendingRequests = new Map<string, Map<string, { kind: "permission" | "question"; name: string | null; summary: string | null }>>();

  constructor(options: OpenCodeOptions) {
    this.explicitBaseUrl = options.baseUrl !== undefined;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/$/, "");
    this.request = options.fetch ?? fetch;
    this.source = options.sse;
    this.projectRoot = options.projectRoot;
    this.log = options.logger ?? (() => {});
    this.launch = options.spawn ?? spawn;
    this.update = options.onProjectionUpdate;
    this.stateUpdate = options.onOperationalState;
    this.autoStartOwned = options.autoStartOwned ?? false;
    this.retry = {
      baseDelayMs: options.retry?.baseDelayMs ?? 100,
      maxDelayMs: options.retry?.maxDelayMs ?? 5000,
      slowDelayMs: options.retry?.slowDelayMs ?? 10000,
      rapidFailureLimit: options.retry?.rapidFailureLimit ?? 5,
      random: options.retry?.random ?? Math.random,
      sleep: options.retry?.sleep ?? sleep
    };
  }

  get owned(): boolean { return this.child !== null; }
  get snapshot(): SessionProjection[] { return [...this.projections.values()]; }

  async connect(): Promise<void> {
    this.stopped = false;
    try {
      await this.verifyConnection();
    } catch (error) {
      if (!this.autoStartOwned || this.explicitBaseUrl || this.child) throw error;
      await this.startOwned();
      return;
    }
    await this.startObservation();
  }

  async reconcile(): Promise<void> {
    if (this.refreshing) { this.refreshPending = true; return; }
    this.refreshing = true;
    const sequence = ++this.refreshSequence;
    try {
      const sessions = await this.get("/session");
      const list = Array.isArray(sessions) ? sessions : Array.isArray(sessions?.sessions) ? sessions.sessions : [];
      const statuses = await this.get("/session/status");
      const next = new Map<string, SessionProjection>();
      for (const session of list) {
        const id = session?.id ?? session?.sessionID;
        if (typeof id !== "string" || id.trim().length === 0) continue;
        const detail = await this.get(`/session/${encodeURIComponent(id)}`);
        const messages = await this.get(`/session/${encodeURIComponent(id)}/message`);
        const contradictoryIdentity = detail?.id !== id && detail?.sessionID !== id;
        const authoritative = contradictoryIdentity ? { ...session } : { ...session, ...(detail && typeof detail === "object" ? detail : {}), id };
        const statusResult = statusFor(statuses, id);
        if (statusResult.value?.match(/^(completed|success|failed|error)$/i)) this.sessionErrors.delete(id);
        const observed = {
          ...observationFromMessages(messages),
          ...this.pendingObservation(id),
          status: statusResult.value,
          invalid: contradictoryIdentity || statusResult.malformed,
          ...(this.sessionErrors.has(id) && !statusResult.value?.match(/^(completed|success|failed|error)$/i) ? { sessionError: true } : {})
          invalid: contradictoryIdentity || statusResult.malformed,
          ...(this.sessionErrors.has(id) && !statusResult.value?.match(/^(completed|success|failed|error)$/i) ? { sessionError: true } : {})
        };
        const projection = projectSession(authoritative, this.projectRoot, observed);
        if (projection) next.set(projection.sessionId, projection);
      }
      if (sequence !== this.refreshSequence || this.stopped) return;
      this.projections = next;
      this.publish();
    } catch (error) {
      this.markStale(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.refreshing = false;
      if (this.refreshPending && !this.stopped) {
        this.refreshPending = false;
        void this.reconcile().catch(() => undefined);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.refreshSequence++;
    this.refreshPending = false;
    this.observation = null;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  async startOwned(command = "opencode"): Promise<void> {
    if (this.child) return;
    const child = this.launch(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopped) {
        this.markStale("Garden-owned OpenCode server exited");
        this.stateUpdate?.("reconnecting", "Garden-owned OpenCode server exited");
      }
    });
    const outputs = [child.stdout, child.stderr].filter((output): output is NonNullable<typeof output> => output !== null);
    if (outputs.length === 0) throw new Error("OpenCode server did not provide startup output");
    try {
      const address = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        const onData = (chunk: Buffer | string) => {
          buffer += chunk.toString();
          const match = buffer.match(/(?:listening on|at)\s+(https?:\/\/[^\s]+)/i);
          if (match) {
            for (const output of outputs) output.off("data", onData);
            resolve(match[1]);
          }
        };
        for (const output of outputs) output.on("data", onData);
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`OpenCode server exited during startup${code === null ? "" : ` with code ${code}`}`)));
      });
      this.baseUrl = address.replace(/\/$/, "");
      await this.verifyConnection();
      await this.startObservation();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async consumeEvent(data: string): Promise<SessionProjection[] | null> {
    try {
      const event = JSON.parse(data) as SseFrame;
      if (!event || typeof event.type !== "string") throw new Error("invalid event");
      if (!EVENT_TYPES.has(event.type)) {
        this.log(`Ignoring unknown OpenCode event ${event.type}`);
        return null;
      }
      this.rememberSessionError(event);
      this.applyWaitingEvent(event);
      await this.reconcile();
      return this.snapshot;
    } catch (error) {
      this.log(`OpenCode event parse failure: ${error instanceof Error ? error.message : String(error)}`);
      await this.reconcile().catch(() => undefined);
      return this.snapshot;
    }
  }

  markStale(message = "OpenCode projection is stale"): void {
    this.projections = new Map([...this.projections].map(([id, value]) => [id, { ...value, status: { ...value.status, freshness: "stale" } }]));
    this.publish();
    this.stateUpdate?.("stale", message);
  }

  private async verifyConnection(): Promise<void> {
    const health = await this.get("/global/health");
    const version = health?.version;
    if (health?.healthy !== true || typeof version !== "string" || !/^1\.18\.\d+$/.test(version)) {
      this.stateUpdate?.("unsupported_version", `Observed ${version ?? "unknown"}`);
      throw new Error(`Unsupported or unhealthy OpenCode server (observed ${version ?? "unknown"}; supported 1.18.x, reference 1.18.18)`);
    }
    await this.get("/doc");
    await this.reconcile();
  }

  private async startObservation(): Promise<void> {
    if (!this.source || this.observation) return;
    this.observation = this.observe();
    await Promise.resolve();
  }

  private async observe(): Promise<void> {
    let failures = 0;
    let reconciled = false;
    while (!this.stopped) {
      try {
        if (!reconciled) {
          await this.reconcile();
          reconciled = true;
        }
        this.streamAbort = new AbortController();
        const stream = await this.source!(this.baseUrl, this.streamAbort.signal);
        this.stateUpdate?.("connected");
        for await (const event of stream) {
          if (this.stopped) return;
          if (EVENT_TYPES.has(event.type)) {
            this.rememberSessionError(event);
            this.applyWaitingEvent(event);
            await this.reconcile().catch(() => undefined);
          }
          else this.log(`Ignoring unknown OpenCode event ${event.type}`);
          failures = 0;
        }
        if (!this.stopped) throw new Error("OpenCode SSE stream ended");
      } catch (error) {
        if (this.stopped) return;
        this.markStale(error instanceof Error ? error.message : String(error));
        try {
          await this.reconcile();
          reconciled = true;
        } catch {
          reconciled = false;
        }
        failures += 1;
        this.stateUpdate?.("reconnecting", "OpenCode observation is reconnecting");
        const exponential = Math.min(this.retry.baseDelayMs * (2 ** (failures - 1)), this.retry.maxDelayMs);
        const delay = failures > this.retry.rapidFailureLimit ? Math.max(exponential, this.retry.slowDelayMs) : exponential;
        await this.retry.sleep(delay + Math.floor(this.retry.random() * delay));
      } finally {
        this.streamAbort = null;
      }
    }
  }

  private publish(): void {
    try { this.update?.(this.snapshot); } catch (error) { this.log(`Projection callback failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private rememberSessionError(event: SseFrame): void {
    if (event.type !== "session.error") return;
    const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : {};
    const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : typeof properties.sessionId === "string" ? properties.sessionId : typeof properties.id === "string" ? properties.id : undefined;
    if (sessionId) this.sessionErrors.add(sessionId);
  }

  private async get(path: string): Promise<any> {
    const response = await this.request(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`OpenCode GET ${path} failed with HTTP ${response.status}`);
    return response.json();
  }

  private pendingObservation(sessionId: string): Record<string, unknown> {
    const requests = [...(this.pendingRequests.get(sessionId)?.values() ?? [])];
    const permission = requests.find((request) => request.kind === "permission");
    const question = requests.find((request) => request.kind === "question");
    const activity = permission ?? question;
    return activity ? {
      ...(permission ? { permission: true } : {}),
      ...(question ? { question: true } : {}),
      parts: [{ type: activity.kind, name: activity.name, state: "pending", summary: activity.summary }]
    } : {};
  }

  private applyWaitingEvent(event: SseFrame): void {
    if (event.type === "session.deleted") {
      const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, any> : {};
      const sessionId = textValue(properties.sessionID) ?? textValue(properties.sessionId) ?? textValue(properties.id);
      if (sessionId) this.pendingRequests.delete(sessionId);
      return;
    }
    if (!event.properties || typeof event.properties !== "object") return;
    const properties = event.properties as Record<string, any>;
    const sessionId = textValue(properties.sessionID) ?? textValue(properties.sessionId) ?? textValue(properties.session?.id);
    const kind = event.type.startsWith("permission.") ? "permission" : event.type.startsWith("question.") || event.type.startsWith("input.") ? "question" : null;
    if (!sessionId || !kind) return;
    const requestId = textValue(properties[`${kind}ID`]) ?? (kind === "question" ? textValue(properties.inputID) : null) ?? textValue(properties.requestID) ?? textValue(properties.id);
    if (!requestId) return;
    const requests = this.pendingRequests.get(sessionId) ?? new Map();
    if (event.type.endsWith(".asked")) {
      requests.set(`${kind}:${requestId}`, { kind, name: textValue(properties.name), summary: mask(textValue(properties.summary)) });
      this.pendingRequests.set(sessionId, requests);
      return;
    }
    if (event.type.endsWith(".replied")) {
      requests.delete(`${kind}:${requestId}`);
      if (requests.size === 0) this.pendingRequests.delete(sessionId);
    }
  }

}

function statusFor(statuses: any, id: string): { value?: string; present: boolean; malformed: boolean } {
  const entry = Array.isArray(statuses)
    ? statuses.find((item) => item?.id === id || item?.sessionID === id)
    : statuses && typeof statuses === "object" ? statuses[id] : undefined;
  if (entry === undefined) return { present: false, malformed: false };
  const value = normalizeStatus(entry);
  return { value, present: true, malformed: value === undefined };
}

function normalizeStatus(status: any): string | undefined {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object") return undefined;
  return typeof status.status === "string" ? status.status : typeof status.type === "string" ? status.type : undefined;
}

const textValue = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;

function observationFromMessages(messages: any): Record<string, unknown> {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : [];
  const allParts = list.flatMap((message: any) => Array.isArray(message?.parts) ? message.parts : message?.part ? [message.part] : []);
  const latest = list.at(-1);
  const parts = Array.isArray(latest?.parts) ? latest.parts : latest?.part ? [latest.part] : [];
  return {
    ...(terminalMessageErrorOf({ parts: allParts }) ? { terminalMessageError: true } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    ...(latest && typeof latest === "object" ? latest : {})
  };
}
