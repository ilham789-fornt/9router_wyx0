# Handoff: 9router WYx0 upstream sync

## Purpose

Continue the selective sync of `decolua/9router` into the WYx0 fork without deleting or narrowing fork-only behavior. This document is a compact continuation note for another agent.

## Repository state

- Repo: `C:\_General\project_gabut\9router_wyx0`
- Branch: `master`
- Worktree: clean at handoff creation
- Local `HEAD`: `74f41b91`
- `upstream/master`: `699edac3` (unchanged since the previous handoff; upstream has published nothing newer)
- Upstream push URL remains disabled.
- Binding contracts: root `AGENTS.md` and child DOX files. Sync history and deferred items are documented in `README.md` under “Upstream Synchronization Status.”

## Completed sync work

Selective batches were ported and pushed directly to `master`. Recent batches include:

- Usage and streaming hardening: exact embedding usage, cache-aware forced SSE→JSON, shared request-detail IDs, a single usage persistence owner, and resilient CodeBuddy tiny-stream retry.
- Gemini usage envelope extraction, forced-stream preservation for JSON-preferring clients, and Hermes/Ollama attachment modality detection and stripping.
- Structured Anthropic token counting, provider-wide parameter rules, custom compatible-provider prefix resolution in translator debugging, Windows RTK `find` support, and dashed Claude Opus 4.7 capabilities.
- Jina Reader JSON POST transport, title/error preservation, and successful-fetch account recovery.
- Provider and CLI feature catch-up: the CLI launcher startup path and menu model lists, thirteen api-key providers, five media providers with their handlers, and Xiaomi MiMo TTS.

Refer to `README.md`, `git log`, and individual commits for patch details.

## Feature gap against upstream

Upstream has published nothing since `699edac3`, so the remaining divergence is not new commits but unported *feature* work from the `v0.5.12`-`v0.5.55` line. Earlier batches deliberately ported only security, compatibility, translator, identity, and usage fixes past `v0.5.8`.

Measure the gap with the same commands the Fork Preservation Rule uses, inverted:

```
# upstream-only files
comm -13 <(git ls-tree -r --name-only HEAD | sort) \
         <(git ls-tree -r --name-only upstream/master | sort)
```

Remaining unported providers and the infrastructure each needs:

- `grok-cli` — executor, `config/grokCli.js`, `services/grokCliModels.js`, usage handler, OAuth wiring.
- `clinepass` — `services/clinepassModels.js`, OAuth wiring.
- `kimchi` — executor plus `services/kimchiModels.js`.
- `devin-cli` — executor; `authType: "none"`.
- `tokenrouter` — api-key only, but introduces `thinkingFormat: "tokenrouter"`, a value `translator/concerns/thinkingUnified.js` does not yet know.
- `codebuddy-intl` and `tencent` stay excluded under the Fork Preservation Rule.

Other unported areas: the `xai video` pipeline (CLI command, `handlers/videoCore.js`, `src/sse/handlers/videoGeneration.js`, four `/v1/videos` routes), `cli/scripts/build-cli.js` and `tray.ps1` packaging, and the `rtk` modules (`headroom.js`, `pxpipe.js`, `systemInject.js`, `ponytailPrompt.js`, `filters/gitLog.js`).

## Verification baseline

- Production `npm run build`: green, 126 pages.
- Latest full-suite run: 20 failing files and 42 failed assertions, 1524 passing. This is the current established baseline; compare against it rather than the older 19/33 figure.
- Full-suite runs can additionally time out in untouched external/live tests such as Trae/Windsurf profile exchange and MiMo Free.
- Fork-only test audit: 68 selected files executed. Existing fork failures remain in Gemini Web, CodeBuddy CN automation, and source-path/no-suite checks.
- Fork preservation audit at the latest batch boundary: 218 fork-only files; missing now: 0.
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
