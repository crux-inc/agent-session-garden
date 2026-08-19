# Issue Tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Repository

- Repository: `crux-inc/agent-session-garden`
- Pull requests as a request surface: no.

## Wayfinding Operations

- Map: one GitHub issue labelled `wayfinder:map`.
- Child tickets: GitHub sub-issues of the map, labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: GitHub native issue dependencies.
- Claim: assign the ticket to the driving developer before work.
- Resolve: comment the decision, close the issue, then append a linked gist to the map's Decisions-so-far section.

## Common Commands

- Create: `gh issue create --title "..." --body "..."`
- View: `gh issue view <number> --comments`
- Comment: `gh issue comment <number> --body "..."`
- Close: `gh issue close <number> --comment "..."`
- Edit labels: `gh issue edit <number> --add-label "..."`
