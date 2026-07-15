# Server Libraries

## Purpose

- Own persistence, provider authentication services, network helpers, usage data, tunnels, updater behavior, MCP integration, and other server-side application services.

## Ownership

- Root database modules such as `localDb.js`, `usageDb.js`, `requestDetailsDb.js`, and `disabledModelsDb.js` own durable local state contracts.
- `db/` owns storage drivers, migrations, repositories, and database lifecycle.
- `oauth/` owns provider authorization, token exchange, refresh, and import services.
- `auth/`, `network/`, `usage/`, `tunnel/`, `updater/`, `mcp/`, and provider-specific folders own their named server domains.

## Local Contracts

- Preserve stored data compatibility and migration order; never discard user data as an incidental fix.
- Keep secrets out of logs, responses, fixtures, and committed files.
- Make writes resilient to partial or concurrent operations using existing repository and transaction patterns.
- File-backed automation snapshots use unique temporary files and Windows-safe replacement; never delete the last valid snapshot before its replacement is durable.
- Preserve provider-connection deduplication by default; use explicit repository options when a caller intentionally supports multiple same-name API-key connections.
- Keep environment and data-directory handling centralized rather than hard-coding platform paths.
- Changes to storage shape, credential lifecycle, or externally visible side effects require tests and documentation updates.

## Work Guidance

- Use existing repository, normalization, and provider service APIs before reaching directly into storage.
- Keep provider-specific token fields and refresh rules in provider-local services.
- Keep browser automation, session scraping, and bulk account import flows inside provider-local OAuth services rather than route handlers or dashboard components.
- Provider bulk import managers should clear provider-specific interstitials, modals, and login gates before deciding a browser session is stuck or needs manual assist.
- Provider automation must use isolated Camoufox sessions; bulk workers run headless and close only the affected worker context after callback capture while retaining redirect-header and navigation-event fallbacks.
- Provider OAuth wrapping may use one visible Camoufox session through a resolved browser-compatible proxy pool; never persist or return the resolved proxy URL or credentials in job state.
- CodeBuddy CN automation follows the recovered enow lifecycle: create the API key, probe credits and gateway state, run best-effort activation, then save credentials with activation and probation metadata; activation uncertainty must not discard otherwise valid credentials.
- CodeBuddy CN 5sim registration must confirm the SMS login surface before buying a number, request OTPs through the visible CodeBuddy UI, and retry after cooldowns without using direct SMS endpoints.
- Keep 5sim client behavior centralized in `oauth/services/fiveSimClient.js`, including token validation, price/stock quote caching, OTP polling, and proxy-dispatched fetches.
- Google automation must evaluate Google OAuth consent before credential inputs and directly probe its approval control; Google can retain a visible password field, localize the consent copy, and place the action in a fixed footer. Consent locator fallbacks must be short and force-enabled so one atypical Google page cannot stall a bulk worker.
- After submitting a Google identifier or password, preserve a short transition cooldown before interacting with that same field again; Google can leave the old field visible while navigation is still in progress.
- Bulk import cancellation must immediately finalize active accounts and prevent late browser callbacks from changing cancelled results or saving new credentials.
- Handle corrupt, absent, and legacy data explicitly where the surrounding module supports recovery.

## Verification

- Run focused database, migration, OAuth, or provider tests under `tests/unit`.
- Run `npm run build` when exports or server bundling change.

## Child DOX Index

- No child DOX files are currently defined; this file owns the full `src/lib` subtree.
