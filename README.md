# 9Router WYx0

WYx0 fork of 9Router focused on provider automation, multi-account workflows, and quota tracking for coding agents.

This repository is forked from [decolua/9router](https://github.com/decolua/9router). The upstream project remains the base AI router. This fork documents and ships the WYx0 changes on top: Kiro automation, CodeBuddy automation, quota tracker upgrades, and small dashboard quality-of-life updates.

This branch tracks upstream 9Router with general parity through `v0.5.8` plus the security/OAuth hardening batch from `v0.5.55`, while preserving WYx0 automation. See **Upstream Synchronization Status** below for the per-batch port log and deferred items.

## Focus

- Kiro bulk login automation with browser-assisted Google account flow and worker progress recovery.
- CodeBuddy and Qoder bulk login automation with browser/device polling and saved OAuth connections.
- Gemini Web cookie onboarding with auto-capture support and dedicated provider branding.
- CodeBuddy quota tracking through the web console usage endpoint when a valid web session cookie is available.
- Quota Tracker improvements, including provider pagination and single-account/bulk display modes.
- Provider UX polish: refreshed provider icons, provider icon fallback, connection status filtering, and related dashboard updates.
- Safer provider workflows: token refresh handling, account fallback, CodeBuddy tiny-stream retry, request detail compaction, and focused tests around the new automation paths.

## Upstream v0.5.4 Included

This fork includes upstream 9Router v0.5.4 updates while retaining WYx0-specific behavior, including:

- Combo Fusion and capacity auto-switch improvements.
- Kiro API-key/headless auth support.
- Claude quota auto-ping and 429 throttling updates.
- Upstream OpenSSE provider registry refactor, with WYx0 providers re-added to the registry.
- Upstream Kiro thinking budget, Antigravity/Kiro/Xiaomi, Combo Fusion, custom vision model, and compatible-node alias fixes from the v0.5.3/v0.5.4 release line.
- Upstream provider, model, translator, CLI, runtime, and dashboard fixes through the v0.5.4 release line.

## What Changed In This Fork

### Automation

- Added `/dashboard/automation` as the entry point for bulk provider workflows.
- Added Kiro bulk import routes and services for browser-based account onboarding.
- Added CodeBuddy and Qoder bulk import routes and services, including browser/device authorization polling.
- Added server-side worker capacity recommendations via `/api/system/capacity`, with browser-device fallback when the endpoint is unavailable.
- Added reusable browser automation helpers for Google login, provider onboarding, region selection, privacy prompts, and manual follow-up.

### Quota Tracking

- Added CodeBuddy to supported usage providers.
- Added CodeBuddy quota parsing for credit packages such as monthly, gift, extra, and activity credits.
- Added a CodeBuddy "Quota Cookie" flow so existing OAuth connections can attach a web console cookie for usage reads.
- Added Quota Tracker pagination and a display mode switch for single-account versus bulk provider views.

### Provider And Dashboard Polish

- Added and refreshed provider visual assets, including CodeBuddy and Gemini Web icons, plus provider icon fallback behavior.
- Removed promotional header actions so the dashboard focuses on routing, providers, and automation controls.
- Improved connection status utilities and provider table ergonomics for automation-heavy workflows.
- Added supporting tests for Kiro/CodeBuddy import managers, route behavior, connection status, and account fallback.

## CodeBuddy Quota Note

CodeBuddy chat uses the plugin/CLI OAuth token, but the CodeBuddy credit usage endpoint is part of the web console and requires a valid web session cookie. New CodeBuddy bulk automation attempts to capture that cookie during browser login. Existing connections can attach it from:

`Dashboard -> Providers -> CodeBuddy -> select connection -> Quota Cookie`

If the cookie is missing or expired, the connection can still chat, but quota tracking will show a clear message instead of fake usage numbers.

## Local Development

For the fastest development loop, use Turbopack:

```bash
cp .env.example .env
npm install
npm run dev:turbo
```

Use the webpack dev server only when debugging Turbopack-specific issues:

```bash
npm run dev
```

Default local URLs:

- Dashboard: `http://localhost:20129/dashboard`
- OpenAI-compatible API: `http://localhost:20129/v1`
- Automation: `http://localhost:20129/dashboard/automation`
- Quota Tracker: `http://localhost:20129/dashboard/quota`
- Server capacity recommendation API: `http://localhost:20129/api/system/capacity`

Fast production-like WYx0 run, using the built CLI/app bundle and project-local data directory:

```bash
node cli/scripts/build-cli.js
npm run wyx
```

If the CLI/app bundle is already current, start WYx0 directly:

```bash
npm run wyx
```

When running beside an original 9Router instance, prefer `http://127.0.0.1:20129/dashboard` to avoid sharing `localhost` auth cookies.
WYx0 also supports isolated dashboard cookies via `.env` so both apps can stay logged in even when opened on the same hostname:

```env
AUTH_TOKEN_COOKIE_NAME=wyx_auth_token
OIDC_STATE_COOKIE_NAME=wyx_oidc_state
OIDC_NONCE_COOKIE_NAME=wyx_oidc_nonce
OIDC_VERIFIER_COOKIE_NAME=wyx_oidc_code_verifier
```

After changing these values for the fast WYx0 runtime, rebuild the CLI/app bundle before starting it again:

```bash
node cli/scripts/build-cli.js
npm run wyx
```

Production build:

```bash
npm run build
PORT=20129 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20129 npm run start
```

## Verification

Recommended checks before opening a PR:

```bash
npm run build
```

Focused unit tests may be run when the local test setup is available:

```bash
npx vitest run tests/unit/kiro-bulk-import-manager.test.js tests/unit/kiro-bulk-import-routes.test.js
npx vitest run tests/unit/codebuddy-bulk-import-manager.test.js tests/unit/codebuddy-bulk-import-routes.test.js
npx vitest run tests/translator/bugs-kiro.test.js tests/translator/format-roundtrip.test.js
```

## PR Scope

This fork's current PR scope is intentionally centered on WYx0 changes:

- Preserve Kiro automation.
- Preserve CodeBuddy and Qoder automation flows.
- Preserve Gemini Web cookie onboarding and provider branding.
- Preserve CodeBuddy quota usage support.
- Preserve quota tracker pagination and bulk/single view behavior.
- Sync upstream 9Router fixes/features while keeping fork metadata and packaging. See **Upstream Synchronization Status** below for what is ported vs. deferred per release.

## Upstream Synchronization Status

Last general sync: **upstream `v0.5.8` (`0c47c891`)**. Security/OAuth hardening is ported through **upstream `v0.5.55` (`699edac3`)**. Sync method: selective per-commit cherry-pick/manual port onto the WYx0 line (not a wholesale merge), preserving all WYx0-only features.

### Security/OAuth batch from upstream v0.5.55

- Socket-derived peer headers require a per-process proof from `custom-server.js`; production, Bun, packaged CLI, and fast WYx0 launchers fail closed instead of trusting spoofable headers.
- IPv4-mapped IPv6 SSRF bypasses are blocked in dotted and WHATWG-canonical hexadecimal forms; client-supplied search base URLs accept public HTTP(S) targets only.
- Remote login with the built-in default password no longer receives a session; request-detail payloads and API keys are redacted from outward responses.
- Outbound proxy schemes, OAuth callback HTML, and MITM startup locking are hardened, including stale-owner recovery only after the recorded process is confirmed dead.
- Trae, Windsurf, and Zed use specialized executors and loopback callback proxies while retaining WYx0's single-file OAuth provider implementation and both `codebuddy` identities.
- Verification: production build green; focused security/provider coverage green; the full suite retains the exact pre-batch baseline of 20 failing files and 34 failed assertions, with no protected fork-only file removed.

### Ported from upstream v0.5.4 → v0.5.8

**Security**
- `GHSA-6mwv-4mrm-5p3m` Kiro region SSRF validation (`assertValidAwsRegion` guard in all OIDC/token/profile endpoints + api-key route body-reflection hardening).
- General SSRF guard for remote validate requests and sensitive settings protection.

**Bugfixes (isolated, no WYx0 clash)**
- Cloudflare-AI content-part flattening (avoid `oneOf` 400).
- Translator tool normalization to Anthropic-native shape for non-Anthropic providers.
- Claude Haiku unsupported adaptive-thinking / `output_config.effort` handling.
- Gemini `pattern` preservation in Antigravity tool schema translation.
- Combo/Fusion Anthropic-style tool-message flattening in panel calls.
- Mimo-free Chrome User-Agent rotation (anti-abuse bypass).
- Anthropic-compatible connection validation via `POST /v1/messages`.
- Perplexity key validation via `/v1/models`.
- `next.config` route entry for the responses endpoint.
- Codex custom-tool preservation during request normalization.
- CLI tool settings tolerate JSONC configs.

**Features**
- OpenCode-Go endpoint alignment.
- Antigravity native image generation (executor + image provider handler + registry `kind:image`).
- Ponytail Claude thinking-signature validator (`claudeSignature.js`) — preserves valid signatures for native Claude, drops invalid blocks; non-Anthropic still uses the safe default. Orthogonal to WYx0's RTK ponytail prompt-injection filter (both coexist).
- CodeBuddy CN Tencent billing usage handler (`services/usage/codebuddy-cn.js`) — replaces the inline probe-URL handler with proper refill/bonus credit-package separation; keeps WYx0's `providerSpecificDataPatch` enrichment.

### Deferred (needs dedicated session — do NOT blind-port)

- **Generic token-refresh profile refactor** from the Trae/Windsurf/Zed OAuth series. The new providers use WYx0's existing refresh module; folding Claude/Qwen/iFlow/GitHub/Kimi into the upstream profile table remains a separate isolated refactor.
- **`codebuddy-intl`, `workbuddy`, and Tencent overlap.** Upstream identities are intentionally not registered because they collide with WYx0's richer `codebuddy` and `codebuddy-cn` implementations. Any later delta must be compared manually without alias shadowing.
- **Headroom proxy lifecycle + Docker sidecar** (`b55cf36d`, `50ed79fe`). Bundled with a deeper architectural change (`resolveTransport` multi-endpoint + `runtimeTransport` in executors) that conflicts with WYx0's CodeBuddy-aware `default.js`/`chatCore.js`. Porting requires threading `runtimeTransport` into WYx0's executor without breaking CodeBuddy auth + the working chat path, then manual verification of several providers.
- **Upstream CodeBuddy CN provider base** (`efd20be8`) and the `cbcn` alias baseline (`791705ae`). WYx0 already ships a richer CN impl; only the quota handler was ported (above). The base provider registry + alias were intentionally kept as WYx0's.
- **API-key management UI / endpoint page refactor** (`25e8723a`) and **custom-models-by-provider-scope** (`707a9155`). Both touch heavily-diverged dashboard files (`EndpointPageClient.js`, `providerCustomModels.js`); defer until those panels are reconciled.

### Sync method (for future updates)

This fork diverges substantially from upstream (~125 WYx0-unique files, ~290 modified-in-both). **Do not run a wholesale `git merge upstream/master`** — it produces 30+ conflicts dominated by the CodeBuddy CN feature-clash. Instead:
1. Fetch upstream and triage each new commit by category (security / safe-bugfix / feature-with-overlap / metadata).
2. Cherry-pick or manually port each item; for features that overlap WYx0 work, compare implementations and keep whichever is better (WYx0's CodeBuddy-aware paths usually win).
3. After each batch, run `npx vitest run --config tests/vitest.config.js` from the repository root and confirm the failing-file set is unchanged from the prior baseline (pre-existing WYx0 test debt, not new regressions).

## Upstream Synchronization & Preservation Checklist (For AI Agents & Developers)

> [!IMPORTANT]
> When syncing with the upstream `decolua/9router` repository, you MUST preserve the following modifications. Do not overwrite or disable these components unless explicitly requested:
>
> 1. **Browser-Stealth Bulk Onboarding & Automation (Camoufox)**:
>    * Do not replace `camoufox-js` with standard Playwright Chromium. All bulk login automations rely on Camoufox's stealth capabilities.
>    * Preserve bulk managers & OAuth flows:
>      * [baseBulkImportManager.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/oauth/services/automation/baseBulkImportManager.js) (durable state management)
>      * [googleOAuth.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/oauth/services/automation/googleOAuth.js) (Google SSO handling)
>      * [codebuddyCnAutomationManager.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/oauth/services/codebuddyCnAutomationManager.js) (CodeBuddy CN login automation)
>      * [geminiWebAutoCapture.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/oauth/services/geminiWebAutoCapture.js) (Gemini Web auto cookie capture)
>    * Ensure dashboard routes (`/dashboard/automation`) and supporting API routes (`/api/oauth/*`, `/api/tools/automation/*`) remain intact.
> 2. **Built-in Proxy Scraper & Live Pool Management**:
>    * Maintain the background proxy scraper scheduler in [proxyScraperScheduler.js](file:///d:/Project_Gabut/9router_wyx0/src/shared/services/proxyScraperScheduler.js) and sources in [sources.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/proxyScraper/sources.js).
>    * Do not remove the live verification of scraped proxies in [proxyPoolsRepo.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/db/repos/proxyPoolsRepo.js) before database storage.
> 3. **CodeBuddy Quota Tracking**:
>    * CodeBuddy requires a web console cookie via the `/v2` usage endpoint for proper credit aggregation. Ensure that the "Quota Cookie" flow and parser in CodeBuddy usage helpers are not overwritten.
> 4. **Database Merge Behavior**:
>    * In [index.js](file:///d:/Project_Gabut/9router_wyx0/src/lib/db/index.js), ensure `mergeAccountsAndProxyPoolsFromDb` is preserved so users can merge backups without complete database wipes.
> 5. **Isolated Coexistence Setup**:
>    * Keep the package name as `wyxrouter` and the default port as `20129`.
>    * Maintain isolated cookie configuration names in `.env.example` and the session parser (e.g. `wyx_auth_token`, `wyx_oidc_state`).
>    * Keep the fast runtime startup script: `npm run wyx`.

## Upstream Credit

9Router WYx0 builds on the original 9Router project by decolua. Keep upstream credit and license notices intact when redistributing or merging changes.

