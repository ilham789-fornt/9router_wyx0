# Automated Tests

## Purpose

- Own Vitest coverage for routing, providers, OAuth, persistence, usage, compatibility formats, and regressions.

## Ownership

- `unit/` owns focused service, route, executor, database, and runtime regression tests.
- `translator/` owns data-driven format coverage and translator-specific bug exposure.
- `vitest.config.js` owns aliases and test runtime configuration.

## Local Contracts

- Keep tests deterministic and offline unless they are explicitly gated as live-provider tests.
- Never commit real provider credentials, cookies, tokens, or exported local databases.
- Match test placement to behavior ownership: general behavior in `unit/`, format bridges in `translator/`.
- Use kebab-style test filenames and focused assertions that describe the compatibility contract.
- Add regression coverage for fixes in routing, translators, OAuth, provider automation, persistence, abort handling, and terminal stream events.

## Work Guidance

- Run the narrowest relevant test file during development, then broaden to the owning suite.
- Mock external services at stable module or network boundaries.
- For provider automation, mirror the existing route and bulk-manager test pattern so job lifecycle, invalid input handling, and saved-connection behavior stay covered offline.
- CodeBuddy Global bulk-login tests cover human-mode route forwarding, visible Camoufox launch options, and sanitized job metadata without exposing proxy credentials.
- Google consent regression tests must cover localized fixed-footer controls and reject synthetic-click false positives by requiring the trusted locator path when it is available.
- Keep live tests gated by an explicit environment variable and tolerant only of genuine credential or quota failures.

## Verification

- Run `cd tests && npm test` for the configured full suite.
- When invoking Vitest from the repository root, pass `--config tests/vitest.config.js`.

## Child DOX Index

- `translator/AGENTS.md` - translator matrix, registration requirements, bridge pitfalls, live-provider gating, and known regression conventions.
