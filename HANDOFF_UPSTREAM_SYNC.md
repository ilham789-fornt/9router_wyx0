# Handoff: 9router WYx0 upstream sync

## Purpose

Continue the selective sync of `decolua/9router` into the WYx0 fork without deleting or narrowing fork-only behavior. This document is a compact continuation note for another agent.

## Repository state

- Repo: `C:\_General\project_gabut\9router_wyx0`
- Branch: `master`
- Worktree: clean at handoff creation
- Local `HEAD`: `a5c0cc82`
- `origin/master`: `a5c0cc82` (already pushed)
- `upstream/master`: `699edac3`
- Upstream push URL remains disabled.
- Binding contracts: root `AGENTS.md` and child DOX files. Sync history and deferred items are documented in `README.md` under “Upstream Synchronization Status.”

## Completed sync work

Selective batches were ported and pushed directly to `master`. Recent batches include:

- Usage and streaming hardening: exact embedding usage, cache-aware forced SSE→JSON, shared request-detail IDs, a single usage persistence owner, and resilient CodeBuddy tiny-stream retry.
- Gemini usage envelope extraction, forced-stream preservation for JSON-preferring clients, and Hermes/Ollama attachment modality detection and stripping.
- Structured Anthropic token counting, provider-wide parameter rules, custom compatible-provider prefix resolution in translator debugging, Windows RTK `find` support, and dashed Claude Opus 4.7 capabilities.
- Jina Reader JSON POST transport, title/error preservation, and successful-fetch account recovery.

Refer to `README.md`, `git log`, and individual commits for patch details.

## Verification baseline

- Production `npm run build`: green, 126 pages.
- Latest deterministic full-suite run, excluding currently timing-out external-network files: 19 failing files and 33 failed assertions; this matches the established baseline.
- Full-suite runs can additionally time out in untouched external/live tests such as Trae/Windsurf profile exchange and MiMo Free.
- Fork-only test audit: 68 selected files executed. Existing fork failures remain in Gemini Web, CodeBuddy CN automation, and source-path/no-suite checks.
- Fork preservation audit at the latest batch boundary: 206 fork-only files; missing now: 0.
- Full Vitest runs rewrite translator snapshots. Restore these after runs if modified:
  - `tests/translator/__snapshots__/golden-request.test.js.snap`
  - `tests/translator/__snapshots__/golden-response-stream.test.js.snap`
  - `tests/translator/__snapshots__/golden-translator-concerns.test.js.snap`
  - `tests/translator/__snapshots__/golden-url-header.test.js.snap`

## Deferred work

Do not blindly port these; reasons are documented in `README.md` and root `AGENTS.md`:

- `resolveTransport`/`runtimeTransport` refactor and Headroom proxy lifecycle/Docker sidecar: structural collision with WYx0 CodeBuddy-aware execution.
- Headroom Responses history patch: target module is absent until Headroom lands.
- Upstream `codebuddy-intl`, `workbuddy`, Tencent/CN provider overlap: WYx0 implementations are richer and protected.
- API-key management/custom-model dashboard refactors: heavily diverged UI files.
- Rotating refresh-token wrapper: no active `xai`/`grok-cli` refresher in WYx0 `DefaultExecutor`.
- Native Gemini path guard: no equivalent vulnerable direct-URL path in this fork.
- Standalone asset-copy and tunnel PID fixes: not yet ported; require separate review against WYx packaging/runtime.

## Recommended next actions

1. Read root `AGENTS.md`, `open-sse/AGENTS.md`, and child DOX files for target paths.
2. Fetch/inspect upstream and choose a small isolated-fix batch; never run `git merge upstream/master`.
3. Derive the fork-only file list with the `comm -23` check from root `AGENTS.md` before and after the batch.
4. Run focused tests, both code-review axes, deterministic full verification, build, and fork-only tests.
5. Restore rewritten snapshots, update `README.md`/owning DOX docs, commit conventionally, and push directly to `origin/master`.

## Suggested skills

- `dox` for every repository edit and DOX-chain update.
- `code-review` after each sync batch, with fixed-point Standards and Spec review.
- `resolving-merge-conflicts` for selective cherry-pick conflicts.
- `diagnosing-bugs` for non-obvious provider/runtime regressions.
- `writing-for-agents` when editing `AGENTS.md`, sync contracts, or this handoff.

## Sensitive-data note

No credentials, cookies, API keys, tokens, or provider secrets are included in this handoff.
