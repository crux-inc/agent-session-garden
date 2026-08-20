import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listen } from "./port.js";
import type { OpenCodeAdapter } from "./opencode.js";

export type GardenServerOptions = { projectRoot: string; port?: number; clientFile?: string; adapter?: OpenCodeAdapter };

export class GardenServer {
  readonly projectRoot: string;
  readonly requestedPort?: number;
  private readonly clientFile: string;
  private readonly adapter?: OpenCodeAdapter;
  private readonly httpServer = createServer((request, response) => this.route(request, response));
  private started = false;

  constructor(options: GardenServerOptions) {
    this.projectRoot = options.projectRoot;
    this.requestedPort = options.port;
    this.clientFile = options.clientFile ?? path.join(process.cwd(), "client", "index.html");
    this.adapter = options.adapter;
  }
  get port(): number { const address = this.httpServer.address(); if (!address || typeof address === "string") throw new Error("Garden Server is not listening"); return address.port; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  async start(): Promise<void> { if (this.started) return; await listen(this.httpServer, this.requestedPort ?? 0); this.started = true; }
  async stop(): Promise<void> { if (!this.started) return; await new Promise<void>((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve())); this.started = false; }
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    if (request.method === "GET" && url.pathname === "/api/health") { this.json(response, 200, { ready: true, server: "ready", reconciliation: this.adapter ? "connected" : "disconnected", adapter: this.adapter ? "connected" : "disconnected" }); return; }
    if (request.method === "GET" && url.pathname === "/api/sessions") { this.json(response, 200, { schemaVersion: 1, project: { root: this.projectRoot }, sessions: this.adapter?.snapshot ?? [] }); return; }
    if (request.method === "GET" && url.pathname === "/api/events") { response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); response.write(`event: ready\ndata: ${JSON.stringify({ ready: true })}\n\n`); request.on("close", () => response.end()); return; }
    if (request.method === "GET" && url.pathname === "/") { try { const client = await readFile(this.clientFile, "utf8"); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(client); } catch { this.json(response, 404, { error: "Browser Client is not built" }); } return; }
    this.json(response, 404, { error: "Not found" });
  }
  private json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
}
