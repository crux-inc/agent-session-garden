# ADR 0001: OpenCode Observation Contract

- Status: Accepted
- Date: 2026-08-19
- Scope: MVP OpenCode adapter

## Decision

The MVP supports OpenCode `v1.18.18` only. The adapter connects to the OpenCode server over its documented local HTTP API and the instance SSE stream; it does not depend on the OpenCode SDK at runtime.

The supported server contract is:

### Server discovery and startup

- The Garden starts `opencode serve --hostname 127.0.0.1 --port 0` when it owns the server, records the process and the listening URL, and may terminate that process on shutdown.
- The Garden never terminates a server it did not start.
- A configured or discovered existing server may be used when its health check succeeds. Discovery is otherwise out of scope for the MVP; the CLI accepts an explicit base URL for this case.
- `GET /global/health` is the readiness check. The response must contain `healthy: true` and a semantic `version` string equal to `1.18.18`.
- `GET /doc` is fetched during connection setup and is used as a diagnostic capability check. It is not used to generate or dynamically change the adapter's runtime types.

### Read-only observation API

The adapter uses only these endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/global/health` | Readiness and exact version check |
| `GET` | `/session` | Initial/reconnection session inventory |
| `GET` | `/session/status` | Authoritative status reconciliation |
| `GET` | `/session/:id` | Session identity and metadata |
| `GET` | `/session/:id/message` | Message and part history for detail views |
| `GET` | `/event` | Instance SSE stream |

The adapter does not send prompts, execute commands, abort sessions, answer permissions, mutate sessions, or call experimental endpoints.

### SSE envelope and relevant events

`GET /event` is an SSE response with `Content-Type: text/event-stream`. Each event's `data` is one JSON object with this envelope:

```json
{
  "type": "<event name>",
  "properties": {},
  "id": "<event id>"
}
```

`id` is retained for logging and diagnostics but is not used as a durable cursor. The first connection event is `server.connected`. The adapter accepts unknown event names and unknown properties, logs them at debug level, and continues processing.

The MVP normalizes these event families when present in `v1.18.18`:

- `session.created`, `session.updated`, and `session.deleted`
- `session.status`
- `message.updated` and `message.removed`
- `message.part.updated` and `message.part.removed`
- `permission.asked` and `permission.replied`
- `session.error`
- tool-part lifecycle changes represented by `message.part.updated`, where a part has a tool state of `pending`, `running`, `completed`, or `error`

The adapter treats event properties as untrusted input. It validates the minimum identifiers needed for routing, preserves the raw payload only in diagnostic logs after sensitive-content masking, and maps everything else to an internal observation type. SSE events are hints for prompt projection updates, not a durable event log.

### Authoritative reconciliation

The Garden performs a full reconciliation:

1. after the health check and before publishing the first projection;
2. after an SSE connection is established;
3. after every SSE disconnect, parse failure, or HTTP failure; and
4. when an event references an unknown session or cannot be applied safely.

Reconciliation reads `/session`, `/session/status`, and session details as needed. The latest successful API result replaces conflicting event-derived state. A failed reconciliation leaves the last projection marked stale; it does not convert the session to `failed`.

### Status mapping

The adapter keeps OpenCode status and tool state as source data, then maps it to the Garden's `Primary Status` at the projection boundary:

- active model or tool work -> `coding` or `tool_calling`;
- a running research-oriented tool, including `WebFetch` when present -> `researching`;
- a permission request -> `waiting_for_permission`;
- an explicit question/input request -> `waiting_for_user`;
- an idle session with no completion marker -> `waiting_for_system`;
- a successful terminal session -> `completed`;
- `session.error`, a terminal error, or a tool error that terminates the run -> `failed`;
- missing, malformed, or contradictory data -> `unknown`.

A tool error alone does not imply a failed Session unless the authoritative session status or terminal message says the run failed. Tool name and tool state remain `Activity Detail`.

### Connection and compatibility policy

- SSE reconnect uses bounded exponential backoff with jitter and no more than five rapid retries before entering a slower retry loop.
- Every reconnect is followed by reconciliation; events are never assumed to be replayed because no durable SSE cursor is part of this contract.
- The adapter requires a `1.18.x` server with the exact MVP capabilities above, and the release test matrix pins `1.18.18` as the reference fixture.
- Patch releases in `1.18.x` are accepted only after the contract tests pass. A changed or missing endpoint, envelope, status shape, or permission/tool signal is a compatibility failure, not silently ignored behavior.
- Other major/minor versions are rejected with an actionable error naming the observed version and supported range. There is no best-effort version negotiation in the MVP.
- The adapter must tolerate additive event types and properties, but not breaking changes to the required endpoints or fields.

## SDK decision

The official `@opencode-ai/sdk` is not required. A narrow HTTP/SSE adapter is preferred because the Garden is read-only, needs only six endpoints, must control version acceptance explicitly, and must keep unknown event handling forward-compatible. The SDK can be used later as a development aid or behind the adapter if its generated client becomes a stable release artifact, but it must not define the Garden's internal observation model or compatibility policy.

## Consequences

- Contract tests can run against recorded HTTP/SSE fixtures without running a browser or OpenCode UI.
- The adapter owns process lifecycle, HTTP authentication plumbing, SSE parsing, reconnects, version checks, and normalization.
- The projection layer remains independent of OpenCode names and schema changes.
- Supporting a newer OpenCode minor version requires an explicit contract review, fixture update, and compatibility decision.

## Verification sources

- OpenCode server documentation: https://opencode.ai/docs/server/
- OpenCode permissions documentation: https://opencode.ai/docs/permissions/
- OpenCode `v1.18.18` release: https://github.com/anomalyco/opencode/releases/tag/v1.18.18
- OpenCode HTTP API source at the reference release: https://github.com/anomalyco/opencode/tree/v1.18.18/packages/opencode/src/server/routes/instance/httpapi
