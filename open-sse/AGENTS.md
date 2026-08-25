# Provider Runtime Core

## Purpose

- Own the provider-neutral streaming engine that converts OpenAI-style requests into provider calls for chat, image, embedding, TTS, STT, search, and fetch workflows.

## Ownership

- `handlers/` owns modality-specific request cores and provider handlers.
- `services/` owns model resolution, token refresh, usage, combos, and account fallback.
- `executors/` owns upstream provider calls; `base.js` defines `BaseExecutor` and `index.js` selects provider executors.
- `providers/` owns provider registry construction, capabilities, pricing, and generated registry imports.
- `config/` owns provider definitions, model metadata, runtime limits, and other constants.
- `translator/` owns request and response format conversion under its nested contract.
- `utils/`, `shared/`, `rtk/`, and `transformer/` own shared streaming and provider-runtime helpers.

## Local Contracts

- Preserve the chat lifecycle: `handlers/chatCore.js` resolves the model, selects an executor, translates the request, streams the upstream response, and translates chunks into the client format.
- Keep models, provider metadata, role and block strings, limits, and other stable values config-driven rather than hard-coded in execution paths.
- Keep warning and default-active metadata separate from `systemDisabled`; warned providers may remain user-enableable unless a hard runtime lock is intentional.
- Use OpenAI as the normal intermediate translator format, but prefer an exact source-to-target registration when the bridge would lose thinking, images, tool identifiers, error state, or wire-format details.
- Keep binary AWS EventStream, protobuf ConnectRPC, and NDJSON handling in their specialized executors instead of treating them as ordinary JSON or SSE translators.
- Preserve abort propagation, streaming order, fallback behavior, terminal errors, and usage accounting across provider paths.
- Streaming usage has one persistence owner: completion handlers call `saveUsageStats`, which retains cache and reasoning metadata; low-level `logUsage` must not create duplicate usage-history or request-log rows.
- A streaming request-detail placeholder and its completion update must share one ID so persistence updates the row instead of appending a duplicate.
- Forced SSE-to-JSON conversion must include cache-read and cache-creation input tokens in client-visible prompt totals and request details.
- Providers marked `forceStream` remain streaming upstream even when a non-streaming client prefers JSON; the forced-SSE conversion layer owns the client-facing JSON response.
- Gemini usage extraction accepts top-level `usageMetadata` and Antigravity/Gemini CLI `{ response: { usageMetadata } }` envelopes without losing cached or reasoning counters.
- SSE transforms must discard malformed non-JSON `data:` payloads and emit any OpenAI `[DONE]` sentinel at most once; same-format Responses streams retain that sentinel, while other translated streams may use their native terminal event plus stream close.
- A streaming request whose upstream returns neither SSE nor JSON must stop before piping, cancel the untrusted body, and return a generic JSON error without reflecting provider HTML or text.
- Keep provider registry `features.usage` and `features.usageApikey` aligned with implemented usage handlers so dashboard/API eligibility matches runtime support.
- Provider-specific usage handlers may return durable metadata patches, but credit refreshes must not overwrite authentication, activation, or gateway-state metadata owned by the provider lifecycle.
- Keep Trae's two-step SOLO transport, Windsurf's gRPC-web protobuf framing, and Zed's hosted NDJSON/RSA exchange in their specialized executors; none is compatible with the default JSON/SSE executor.
- Codex request normalization preserves Responses `text.format` structured-output configuration while stripping fields outside its explicit allowlist.
- Windsurf ToolCallChunk frames must become an explicit compatibility error until their proprietary identifiers are mapped; never discard them as ordinary content or a successful terminal response.
- Treat `providers/registry/index.js` as generated output; regenerate it after adding or removing registry modules.
- Keep registry header keys canonical for their wire protocol; Anthropic's version header is lowercase so compatible request headers cannot create a case-variant duplicate.
- Client-supplied search provider base URLs must accept only public HTTP(S) targets through `src/shared/utils/ssrfGuard.js`; admin-configured registry URLs remain the trusted default.
- Combo modality detection recognizes current-turn message `images`, attachment arrays, direct media fields, and embedded data URIs; unsupported vision payloads are removed before provider dispatch.
- RTK `find` detection and grouping accepts Unix separators and Windows drive-letter/backslash paths while normalizing compacted labels to forward slashes.
- Jina Reader web fetches use the root JSON POST API, retain upstream status/error text, and prefer Jina's `Title:` metadata before Markdown headings.
- Under the root Fork Preservation Rule, keep the WYx0 `codebuddy` and `codebuddy-cn` registries, their aliases, and the CodeBuddy-aware branches in `executors/default.js` and `handlers/chatCore.js`. Upstream's `codebuddy-intl` and `tencent` entries must not shadow or replace them.
- CodeBuddy streaming may buffer a first tiny non-empty completion and retry once before exposing bytes; if the retry fails or is not a successful SSE response, replay the original buffered stream.
- Porting the upstream `resolveTransport`/`runtimeTransport` multi-endpoint refactor requires threading the new transport through the CodeBuddy execution path first; it is not a drop-in replacement for this subtree's executor dispatch.
- No consumer reads a registry `transports[]` array while that refactor is deferred; do not copy the field from upstream entries, because it advertises per-format routing this subtree does not perform.
- `selfhosted-embedding` keeps its own adapter and must never route through `openaiCompatNode`, which defaults to `api.openai.com` when a connection sets no base URL; under a self-hosted provider that silently sends input and credentials to a third party.
- `embeddingsCore` builds url, headers, and body inside a guard and answers `400` with the adapter's reason, so a misconfigured connection is a client error rather than an uncaught `500`.
- STT and TTS resolve a per-connection `providerSpecificData.baseUrl` override ahead of the registry base URL. The override is opt-in and absent for cloud providers, whose fixed registry endpoints stay authoritative.
- TTS providers may keep their model list under `ttsConfig.models` instead of the migrated top-level `models[]`; the dashboard TTS card and `TTS_PROVIDER_CONFIG` both read that nested shape.
- `handleTtsCore` forwards `style` alongside `language` to the adapter; a route that collects either hint must thread it through `src/sse/handlers/tts.js` or the adapter never receives it.

## Work Guidance

- Add a provider by copying `providers/REGISTRY_TEMPLATE.js` to `providers/registry/<id>.js`, then regenerate `providers/registry/index.js`. Models are co-located in the registry entry; `config/providerModels.js` derives `PROVIDER_MODELS` from it and needs no edit.
- Check a new provider's `id`, `alias`, `aliases`, and `uiAlias` against every existing entry before adding it; the registry is keyed by alias, so a collision silently shadows a provider.
- An OpenAI-format api-key provider usually needs no route changes: the generic probe in `src/app/api/providers/validate/route.js` and the registry's own seed models plus `passthroughModels` cover it.
- Add a custom executor only for non-standard upstream behavior; otherwise rely on `DefaultExecutor`.
- Add translators through the existing registration pattern, import registration modules from `translator/index.js`, and reuse translator schema and concern helpers.
- Trace both request and response paths before changing format conversion, fallback, or stream handling.

## Verification

- Run focused executor, routing, fallback, and provider tests under `tests/unit`.
- Run the relevant translator tests under `tests/translator` with `--config tests/vitest.config.js` when formats or model metadata change.
- Run `tests/translator/coverage-all-models.test.js` after provider registry or model-matrix changes.
- Run `npm run build` when exports, configuration, or server bundling changes.

## Child DOX Index

- `translator/AGENTS.md` - request and response format conversion, registrations, bridge constraints, and translator verification.
