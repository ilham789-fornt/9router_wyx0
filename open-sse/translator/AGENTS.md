# Format Translation

## Purpose

- Own request and response conversion between OpenAI, OpenAI Responses, Claude, Gemini, Kiro, Cursor, CommandCode, Ollama, Vertex, Antigravity, and other registered formats.

## Ownership

- `index.js` owns translator registration and source-to-target orchestration.
- `formats.js` owns recognized format identifiers.
- `request/` owns request-side converters.
- `response/` owns response and SSE chunk converters.
- `helpers/` owns shared content, token, image, tool-call, and format utilities.

## Local Contracts

- Translation commonly uses OpenAI as an intermediate format: source to OpenAI to target for requests, and target to OpenAI to source for responses.
- Preserve reasoning, thinking blocks, system content, tool identifiers, tool indexes, argument strings, images, audio, error state, and tool-choice semantics whenever the target supports them.
- OpenAI chat-to-Responses conversion preserves explicitly supplied `prompt_cache_key` and `service_tier`; an empty `tool_calls` array is not a completed tool-call message.
- OpenAI chat-to-Responses conversion treats the first system or developer message as instructions, while Responses-to-Chat conversion removes Responses-only `client_metadata` before provider dispatch.
- Claude preparation must retain image-only and document-only messages, and OpenAI-to-Claude tool conversion must accept both typed and bare `{ function: ... }` wrappers.
- Gemini schema cleanup recursively removes unsupported JSON Schema array, numeric, content, and unevaluated keywords before provider submission.
- Parameter-support rules may be model-matched drops or provider-wide transformations; provider-wide rules do not require `match` or `drop` fields.
- Keep passthrough behavior intact when source and target formats are identical.
- Register new translators through the existing registry pattern and update `tests/translator/registerAll.js` for Vitest.
- Do not treat binary AWS EventStream, protobuf ConnectRPC, or NDJSON envelopes as ordinary SSE or JSON.
- Make lossy conversion explicit and cover compatibility regressions with focused tests.

## Work Guidance

- Trace both legs of the intermediate-format bridge before changing a converter.
- Use helpers for stable tool IDs, argument normalization, image handling, and provider-specific content blocks.
- Preserve unknown compatible fields where possible instead of aggressively reshaping payloads.
- Check model metadata in `open-sse/config/providerModels.js` when target format selection appears incorrect.

## Verification

- Run the relevant file under `tests/translator` with `--config tests/vitest.config.js`.
- Run `coverage-all-models.test.js` when registrations, formats, or provider model metadata change.
- Use executor-level tests for Kiro, Cursor, CommandCode, and other formats whose wire envelopes do not round-trip through plain translator tests.

## Child DOX Index

- No child DOX files are currently defined; this file owns the full `open-sse/translator` subtree.
