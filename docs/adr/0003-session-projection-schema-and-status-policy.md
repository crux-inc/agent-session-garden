# ADR 0003: Session Projection Schema and Status Policy

- Status: Accepted
- Date: 2026-08-20
- Scope: Session Projection, status inference, project filtering, and browser/server protocol

## Decision

The Garden publishes a complete, current `Session Projection` for each OpenCode session that belongs to the launch `Project`. A projection is a read model, not a copy of OpenCode history. It contains only the fields needed to identify and render a session, describe its current activity, and communicate freshness.

The wire representation is versioned and uses this schema:

```ts
type PrimaryStatus =
  | "coding"
  | "tool_calling"
  | "researching"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "waiting_for_system"
  | "completed"
  | "failed"
  | "unknown";

type ProjectionFreshness = "fresh" | "stale";

type GardenRole = "builder" | "planner" | "generic";

type SessionProjection = {
  schemaVersion: 1;
  sessionId: string;
  project: {
    root: string;
  };
  displayName: string;
  agent: {
    name: string;
    gardenRole: GardenRole;
  };
  model: {
    provider: string;
    id: string;
    appearanceKey: string;
  };
  status: {
    primary: PrimaryStatus;
    freshness: ProjectionFreshness;
    changedAt: string;
  };
  activity: ActivityDetail | null;
  lifetime: {
    startedAt: string;
    endedAt: string | null;
  };
};

type ActivityDetail = {
  kind: "tool" | "message" | "permission" | "question";
  name: string | null;
  state: "pending" | "running" | "completed" | "error" | null;
  summary: string | null;
};
```

`GardenRole` is a closed presentation mapping owned by the Garden. The initial mapping is `build -> builder`, `plan -> planner`, and every other agent name -> `generic`. The mapping is deterministic and does not affect status inference. `appearanceKey` is the lowercase string `<provider>:<id>` after trimming both validated components; clients use this canonical key to select appearance, including clothing color, without reimplementing model parsing. Provider and id comparisons are case-insensitive only for this key; their observed values remain unchanged in the projection.

## Field Policy

- `sessionId`, `project.root`, `agent.name`, `model.provider`, `model.id`, `lifetime.startedAt`, and the terminal time are observed facts. They are retained only after the adapter validates their required shape.
- `displayName` is Garden presentation data. Use the OpenCode session title when it is a non-empty string; otherwise use `Session <short session id>`, where the short id is the first eight characters. Names are not required to be globally unique.
- `gardenRole`, `appearanceKey`, `status.primary`, and `activity` are Garden-derived values. They must be reproducible from validated observations and the fixed policy below.
- `status.freshness` is connection/reconciliation metadata. A failed refresh changes `fresh` to `stale` and retains the last known primary status and activity. It never changes a session to `failed`.
- `status.changedAt` is the timestamp at which the current primary status was last changed by the projection. It is not the timestamp of the most recent event.
- `activity.summary` is best-effort detail and must be masked before publication. Raw messages, prompts, tool inputs, credentials, and full event payloads are not part of this schema.
- Times are RFC 3339 strings in UTC. If a required non-project identity or lifetime field is absent, malformed, or contradictory, the projection is still safe to publish only with `unknown` status and nullable activity; it must not invent identity values. A session with no valid project identity cannot be included in a project projection.

## Project Filtering

The Garden computes one canonical project root at startup: the Git repository root for the launch directory, or the launch directory when no repository can be identified. A session is included when its validated working directory is the root or a descendant of the root. Both roots are normalized with absolute resolution and symlinks resolved before comparison; comparison is path-segment based and does not treat a similarly prefixed sibling as a descendant. Missing, malformed, or contradictory project identity excludes the session from the project snapshot and is logged as a diagnostic observation; it is not guessed into the project. The Browser Client never performs this filtering.

## Status Precedence

The projection evaluates the following rules from highest to lowest precedence. The first applicable rule wins. Authoritative reconciliation data wins over event-derived data before these rules are evaluated. An OpenCode `session.status` is terminal-success when its status is `completed` or `success`, and terminal-error when its status is `error` or `failed`. A `session.error` event or a terminal message part with an error state is also terminal-error. A permission request is outstanding after `permission.asked` until its matching `permission.replied`; an explicit question/input request is represented by the corresponding pending question/input signal in the normalized observation. A model-generation observation is active while the current message/part reports a pending or running assistant generation, and writing/coding work is active while a current assistant part reports a write/edit/patch operation without a current tool.

1. Invalid or contradictory required observations -> `unknown`.
2. An authoritative successful terminal marker -> `completed`.
3. An authoritative terminal error, `session.error`, or a terminal message indicating the run failed -> `failed`.
4. An outstanding permission request -> `waiting_for_permission`.
5. An explicit question or input request -> `waiting_for_user`.
6. A running research-oriented tool, including `WebFetch` -> `researching`.
7. Any other pending or running tool -> `tool_calling`.
8. Active model generation or writing/coding work without an active tool -> `coding`.
9. A valid non-terminal session with no active work -> `waiting_for_system`.
10. No rule above, including insufficient observations -> `unknown`.

Permission takes precedence over user waiting because authorization is the immediate action OpenCode requires. Both waiting states take precedence over activity because the session cannot progress until the request is resolved. Researching takes precedence over generic tool calling because it is a more specific visual state. A completed or failed terminal marker is evaluated before transient activity so late events cannot make an archived session appear active; reconciliation may replace a stale event-derived terminal marker with the authoritative result.

A tool in `error` state is retained in `activity` with `state: "error"`, but does not produce `failed` by itself. It produces `failed` only when authoritative session state or a terminal message says the run terminated unsuccessfully.

## Activity Policy

`activity` describes the most relevant current detail without changing the primary status. For an active tool it contains `kind: "tool"`, the tool name, and its validated state. A `WebFetch` activity therefore has `primary: "researching"` and remains visible as tool detail. Permission and question requests retain their names and masked summaries. There is at most one current activity in a projection; selection among simultaneous non-terminal parts is deterministic: permission, question, research tool, other tool, then message generation.

Terminal projections have `activity: null` unless a terminal diagnostic is needed, in which case it is represented only by the status and masked summary fields permitted by the schema. Stale projections retain their previous activity rather than presenting connection loss as session activity.

## Consequences

- The Browser Client can render a complete projection without knowing OpenCode's event or status vocabulary.
- Status rendering is deterministic and testable as a pure projection policy.
- Freshness is visible without conflating Garden connectivity failures with failed OpenCode sessions.
- The schema intentionally does not provide durable history, raw event replay, or mutation commands.
- Adding a primary status, role, or schema field requires a protocol version and contract review rather than silently changing client behavior.
