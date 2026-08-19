# ADR 0002: MVP Runtime and Package Boundary

- Status: Accepted
- Date: 2026-08-19
- Scope: MVP runtime, package, local server, browser client, and test boundaries

## Decision

The MVP is one TypeScript package executed on Node.js 20 or newer. It contains the CLI, Garden Server, OpenCode adapter, projection/reconciliation layer, Browser Client, shared browser/server protocol types, and tests. These are internal module boundaries, not separately published packages or a workspace/monorepo. The package's public surface is the CLI and the browser/server protocol; adapter and projection implementation modules remain package-private.

The CLI is the only entry point. It starts a Garden-owned Server for one Project, binds only to `127.0.0.1`, chooses the next available port when no port is specified, and fails rather than changing an explicitly requested port. It prints the URL by default and only opens a browser when explicitly requested. The CLI stops a Garden-owned Server on shutdown and never stops an OpenCode server it did not start. Desktop packaging, background daemons, LAN/remote access, authentication, TLS, and multi-Project views are out of scope.

The Garden Server owns all OpenCode connectivity, event handling, reconciliation, status inference, and sensitive-content masking. The Browser Client is read-only and receives only Session Projections through a browser-facing protocol:

- `GET /api/health` reports server, reconciliation, and adapter readiness.
- `GET /api/sessions` returns a Projection Snapshot when ready.
- `GET /api/events` provides an SSE stream of Projection Updates and freshness/connection signals.
- The server serves the compiled Browser Client assets and does not expose a raw OpenCode proxy.

REST is used for snapshots and SSE for live updates. On initial load or reconnect, the Browser Client fetches a snapshot before subscribing again. The stream does not provide durable event replay, exactly-once delivery, or `Last-Event-ID` semantics. REST and SSE payloads use a versioned protocol schema and expose projections rather than raw OpenCode Events. The production server is same-origin; development may use a Vite server that proxies `/api/*` to the Garden Server, without broad CORS access.

Node's built-in `http` server handles routing, JSON, SSE, static assets, and graceful shutdown. TypeScript compiles the Node code and a single browser bundler (Vite or equivalent) builds client assets. Tests use the repository's existing Node-compatible runner or Vitest if none exists: pure projection tests, fake adapter contract/integration tests, server REST/SSE/lifecycle tests, CLI tests, and Browser Client rendering/SSE-state tests. Real OpenCode, external network, Playwright, and full browser E2E are not MVP test dependencies. External boundaries use injected clocks, fake event/HTTP sources, and controllable shutdown signals.

## Consequences

- The MVP remains installable and runnable as one local Node package without committing to desktop distribution.
- Projection and protocol tests can validate the domain and transport independently of a browser or real OpenCode server.
- Snapshot-first reconnects keep the Browser Client and server simple, at the cost of no event replay during outages.
- The package can later be split or wrapped by a desktop shell without making those concerns part of the MVP contract.
