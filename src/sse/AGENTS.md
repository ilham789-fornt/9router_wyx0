# Application Routing Bridge

## Purpose

- Own request parsing, model and combo resolution, credential selection, account fallback coordination, and handoff from Next.js routes to `open-sse`.

## Ownership

- `handlers/` owns endpoint-level orchestration such as chat handling.
- `services/` owns application-side model and routing services.
- `utils/` owns logging and small SSE bridge utilities.

## Local Contracts

- Preserve client disconnect and abort propagation through streaming paths.
- Keep combo fallback and account fallback ordering deterministic.
- Delegate provider execution and format translation to `open-sse`; do not duplicate executor logic here.
- Keep usage and request-detail recording consistent across streaming and non-streaming responses.
- Persist embedding usage only when the provider reports an exact positive input-token total with zero output tokens; do not store estimates or malformed counters as exact usage.
- Treat routing, retries, cooldowns, and terminal errors as user-visible behavior requiring focused tests.
- Web-fetch account errors are cleared only after the provider core returns success; recovery clears persisted error codes alongside status and backoff state.

## Work Guidance

- Trace a request from its App Router endpoint through this bridge and into `open-sse` before changing control flow.
- Preserve model aliases, provider prefixes, combo semantics, and connection selection.

## Verification

- Run focused routing, fallback, abort, and provider-selection tests under `tests/unit`.
- Run translator tests as well when request or response formats can change.

## Child DOX Index

- No child DOX files are currently defined; this file owns the full `src/sse` subtree.
