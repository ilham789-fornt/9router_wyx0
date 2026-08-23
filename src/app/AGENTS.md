# App Router

## Purpose

- Own dashboard pages and the HTTP API exposed by the Next.js App Router.

## Ownership

- `(dashboard)/`, `dashboard/`, `login/`, `landing/`, and `callback/` own user-facing routes.
- `api/v1/` and `api/v1beta/` own OpenAI, Anthropic, Gemini, and compatible client-facing endpoints.
- Other `api/` directories own dashboard management, provider setup, OAuth, keys, usage, sync, media, translator, tunnel, system capacity, and runtime control endpoints.

## Local Contracts

- Keep compatibility endpoints thin: validate HTTP input, delegate to shared routing or service modules, and preserve expected status, headers, streaming, and error formats.
- Treat provider credentials, cookies, API keys, OAuth tokens, and request logs as sensitive.
- Never issue a dashboard session for remote authentication with the built-in default password, and redact conversation payloads from request-detail API responses.
- Preserve Next.js server/client boundaries; add `"use client"` only where browser state or APIs require it.
- Keep dashboard behavior aligned with the corresponding API contract and shared store.
- Keep provider-detail bulk connection actions scoped to the selected connection IDs, and require confirmation before destructive bulk actions.
- Provider management APIs allow multiple saved OpenAI- and Anthropic-compatible connections per compatible node; custom embedding nodes remain single-connection unless that contract is intentionally changed.
- Present Camoufox as the single automation runtime in dashboard flows; do not expose browser-runtime selection controls.
- OAuth-via-proxy dashboard flows select active browser-compatible proxy pools by ID and delegate proxy resolution, browser launch, token polling, and credential persistence to provider-local services.
- Trae, Windsurf, and Zed browser authentication use loopback-only callback proxies with registered session state; Zed's RSA private verifier travels in the POST body, never a query string.
- CodeBuddy Global bulk GSuite UI requires an active browser-compatible proxy pool; only the pool ID crosses the client boundary, while the provider manager enforces one unique proxy per account.
- The CodeBuddy Global GSuite modal exposes an opt-in human-mode boolean; the route accepts only literal `true` and delegates all timing and browser behavior to the provider manager.
- CodeBuddy Global GitHub-register UI (temp-mail signup + chained OAuth) requires an active browser-compatible proxy pool with one unique proxy per requested account; the shared BulkAccountAutomationModal enters `accountCountMode` for this flow, replacing the paste-accounts textarea with a numeric input and sending `{ count }` (or nothing, for auto-random 20..30) to `/api/oauth/codebuddy-github-register/bulk-import`. Temp-mail credentials, generated GitHub credentials, and proxy URLs never cross the client boundary.
- Keep `/api/system/capacity` limited to coarse server CPU/RAM capacity data for local worker recommendations; do not expose sensitive host details.
- Keep CodeBuddy CN out of the generic OAuth Providers section: its provider detail deep-links to the dedicated Automation tab, where OAuth and 5sim bulk registration remain separate modes.
- Keep CodeBuddy CN 5sim quote/check routes under the dedicated automation API surface and return sanitized balance, stock, affordability, and proxy-route metadata only.
- Do not silently change `/v1/*` compatibility semantics without focused regression tests.

## Work Guidance

- Follow nearby route and component patterns before adding abstractions.
- Reuse shared dashboard components and existing provider metadata.
- Keep `api/oauth/*/bulk-import` handlers thin: validate input, delegate to bulk import managers, and preserve the shared job JSON shape used by `BulkAccountAutomationModal`.
- For user-facing changes, verify loading, empty, error, disabled, and narrow-screen states.

## Verification

- Run focused unit tests for the affected route or provider flow.
- Run `npm run build`.
- For dashboard changes, run the app and inspect the affected workflow in a browser.

## Child DOX Index

- No child DOX files are currently defined; this file owns the full `src/app` subtree.
