# Agent Session Garden

Agent Session Garden is a local observability garden for OpenCode sessions in a project. It presents each session as a character whose visual identity comes from its agent and model, while its activity is represented through a small set of domain states and corresponding office actions.

## Participants

**Agent**:
The OpenCode agent identity used by a session, such as `build` or `plan`. It is the source identity for deriving a Garden role.

**Garden Role**:
A visual role derived from an OpenCode Agent through a fixed mapping. Unknown agents use a generic role rather than disappearing from the Garden.

**Model**:
The model provider and complete model identity used by a Session. Together with Agent, it determines the character's visual appearance, including clothing color.

**Session**:
A single concrete OpenCode work execution with a stable identity, display name, Agent, Model, activity, state, and lifetime.

**Session Character**:
The Garden representation of one Session in the office scene.

**Project**:
The Git repository root associated with the Garden launch directory, or the launch directory itself when no Git repository can be identified.

## Observation

**Primary Status**:
The one main state currently assigned to a Session for visual presentation. The first set includes `coding`, `tool_calling`, `researching`, `waiting_for_user`, `waiting_for_permission`, `waiting_for_system`, `completed`, `failed`, and `unknown`.

**Activity Detail**:
Additional observed or inferred detail about a Session's current primary status, such as a tool name and its execution state. A `WebFetch` activity can make the primary status `researching` while remaining visible as tool detail.

**Event**:
An observation emitted by OpenCode that can update a Session projection. Events are not animations and are not treated as the Garden's durable session history.

**Researching**:
A Session activity inferred from research-oriented work, including a `WebFetch` operation. The underlying tool call remains available as Activity Detail.

**Session Projection**:
Garden's current, reconciled view of a Session, derived from OpenCode events and authoritative API queries rather than being a second durable copy of the session history.

**Stale Projection**:
A Session Projection whose last known status is retained but has not been refreshed because the Garden's connection or authoritative query is unavailable. Stale is freshness information, not a Primary Status.

**Reconciliation**:
The process of querying OpenCode's authoritative APIs to rebuild or correct Session Projections after startup, reconnection, or suspected event inconsistency.

## Lifecycle

**Waiting for User**:
A primary status in which OpenCode requires user input or confirmation.

**Waiting for Permission**:
A distinct primary status in which an operation requires user authorization.

**Waiting for System**:
A primary status in which the Session is waiting for model, server, network, tool, or another external process.

**Completed Session**:
A Session that has finished successfully and is represented in the archive or history area.

**Failed Session**:
A Session that has finished with an error and is represented in a distinct archive or history area. A tool failure or Garden connection loss alone does not establish this state.

**Garden-owned Server**:
An OpenCode server started by this Garden instance and still held by it. Garden may stop this server when it exits; it must not stop a server it did not start.

**Archive**:
The Garden scene area for completed and failed Session Characters. It shows a bounded recent history rather than duplicating all OpenCode session data.

**Sensitive Content Masking**:
Best-effort redaction of credential-like values, including common API keys, tokens, passwords, secrets, private keys, environment variables, and credential fields, before raw observed content is shown in the UI.

## Delivery Boundary

**Garden Server**:
The local process boundary that observes OpenCode and publishes a Project's Session Projections to the Browser Client. It is owned by the Garden CLI for its lifetime and is distinct from an OpenCode server.

**Browser Client**:
The read-only visual client for a Project's Session Projections. It does not connect to OpenCode or issue commands that mutate Sessions.

**Projection Snapshot**:
A point-in-time collection of the Project's currently visible Session Projections.

**Projection Update**:
A complete Session Projection published when the Garden Server observes a change. It is an update to the current view, not a replayable Event or durable history record.
