import { spawn, type ChildProcess } from "node:child_process";
import type { SessionProjection } from "./projection.js";
import { projectSession } from "./projection.js";

export type FetchLike = typeof fetch;
export type OpenCodeOptions = { baseUrl?: string; fetch?: FetchLike; projectRoot: string; spawn?: typeof spawn; logger?: (message: string) => void; onProjectionUpdate?: (snapshot: SessionProjection[]) => void };
export class OpenCodeAdapter {
  readonly baseUrl: string;
  private readonly request: FetchLike;
  private readonly projectRoot: string;
  private readonly log: (message: string) => void;
  private readonly launch: typeof spawn;
  private readonly update?: (snapshot: SessionProjection[]) => void;
  private child: ChildProcess | null = null;
  private projections = new Map<string, SessionProjection>();
  constructor(options: OpenCodeOptions) { this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/$/, ""); this.request = options.fetch ?? fetch; this.projectRoot = options.projectRoot; this.log = options.logger ?? (() => {}); this.launch = options.spawn ?? spawn; this.update = options.onProjectionUpdate; }
  get owned(): boolean { return this.child !== null; }
  get snapshot(): SessionProjection[] { return [...this.projections.values()]; }
  async connect(): Promise<void> { const health = await this.get("/global/health"); const version = health?.version; if (health?.healthy !== true || typeof version !== "string" || !/^1\.18\.\d+$/.test(version)) throw new Error(`Unsupported or unhealthy OpenCode server (observed ${version ?? "unknown"}; supported 1.18.x, reference 1.18.18)`); await this.get("/doc"); await this.reconcile(); }
  async reconcile(): Promise<void> { const sessions = await this.get("/session"); const list = Array.isArray(sessions) ? sessions : Array.isArray(sessions?.sessions) ? sessions.sessions : []; const next = new Map<string, SessionProjection>(); for (const session of list) { const projection = projectSession(session, this.projectRoot, { status: session.status }); if (projection) next.set(projection.sessionId, projection); } for (const old of this.projections.values()) if (!next.has(old.sessionId)) next.set(old.sessionId, { ...old, status: { ...old.status, freshness: "stale" } }); this.projections = next; this.update?.(this.snapshot); }
  async stop(): Promise<void> { if (!this.child) return; this.child.kill(); this.child = null; }
  async startOwned(command = "opencode"): Promise<void> { if (this.child) return; const child = this.launch(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { stdio: "ignore" }); this.child = child; child.once("exit", () => { if (this.child === child) this.child = null; }); }
  async consumeEvent(data: string): Promise<SessionProjection[] | null> { try { const event = JSON.parse(data); if (!event || typeof event.type !== "string") throw new Error("invalid event"); if (event.type.startsWith("session.") || event.type.startsWith("message.") || event.type.startsWith("permission.")) { await this.reconcile(); return this.snapshot; } this.log(`Ignoring unknown OpenCode event ${event.type}`); return null; } catch { await this.reconcile().catch(() => this.markStale()); return this.snapshot; } }
  markStale(): void { this.projections = new Map([...this.projections].map(([id, value]) => [id, { ...value, status: { ...value.status, freshness: "stale" } }])); }
  private async get(path: string): Promise<any> { const response = await this.request(`${this.baseUrl}${path}`); if (!response.ok) throw new Error(`OpenCode GET ${path} failed with HTTP ${response.status}`); return response.json(); }
}
