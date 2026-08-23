# Repository DOX

## Core Contract

- This file is the project-wide work contract; nested `AGENTS.md` files add local rules for their subtrees.
- Before editing, read every `AGENTS.md` from this root to each target path.
- The nearest document controls local details when instructions differ, without weakening project-wide security or verification requirements.
- After meaningful changes, update the closest owning `AGENTS.md` and every affected parent index.
- Keep durable contracts current; do not record task history or temporary implementation notes here.

## Project Structure

- `src/app` contains the Next.js App Router UI and API routes, including the dashboard under `src/app/(dashboard)` and OpenAI-compatible endpoints under `src/app/api/v1`.
- Shared UI, constants, hooks, and stores live in `src/shared`, `src/store`, and `src/i18n`.
- Routing and provider translation logic is split between `src/sse` and `open-sse`.
- CLI packaging lives in `cli/`, repository scripts in `scripts/`, docs in `docs/` and `gitbook/`, public assets in `public/` and `images/`, and automated tests in `tests/unit` and `tests/translator`.
- GitHub Actions workflows in `.github/workflows` handle publishing, docs deployment, Docker images, and optional WYx0 Discord changelog announcements.
- Root-owned areas without child DOX files include configuration, deployment files, `.github/`, `docs/`, `i18n/`, `images/`, `public/`, empty placeholders, and generated or local runtime folders such as `.data-wyx0/`, `.next*/`, and `node_modules/`.

## Build And Development

Use Node 22 or newer. Camoufox is installed through the root package lifecycle and its runtime assets are fetched during `npm install`.

- `npm run dev:turbo` starts the fastest local development server on `http://localhost:20129`.
- `npm run dev` starts the webpack development server for compatibility and Turbopack debugging.
- `npm run build` creates a production build using `scripts/build-next-safe.mjs`.
- `npm run start` runs the standalone production server.
- `node cli/scripts/build-cli.js` builds the CLI/app bundle used by the fast WYx0 runtime.
- `npm run wyx` starts the fast WYx0 local runtime against the project data directory.
- `npm run cli:pack` builds the bundled CLI package from `cli/`.
- `cd tests && npm test` runs the Vitest suite defined in `tests/package.json`.

## Coding Contracts

- Use ES modules, React 19, Next.js 16, and the shared ESLint configuration in `eslint.config.mjs`.
- Follow the existing JavaScript style: double quotes, semicolons, and mostly 2-space indentation.
- Use `PascalCase` for React components, `camelCase` for functions and stores, and kebab-style test filenames such as `codebuddy-bulk-import-routes.test.js`.
- Keep provider-specific code close to its domain, such as `open-sse/executors/*` or `src/lib/oauth/services/*`.
- Prefer focused changes and preserve existing module boundaries unless a contract change is intentional and documented.
- Use Camoufox as the sole browser automation runtime. Do not add Playwright Chromium or installed-Chrome automation paths; `playwright-core` is retained only as Camoufox's transport dependency and must stay pinned to the version compatible with the installed Camoufox release.

## Testing Contracts

- Add or update Vitest coverage for behavior changes in routing, translators, OAuth flows, or provider automation.
- Place focused unit tests in `tests/unit` and format or compatibility regressions in `tests/translator`.
- Run targeted tests during development, for example `npx vitest run tests/unit/kiro-bulk-import-manager.test.js`.
- Run `npm run build` before opening a pull request.

## Delivery Contracts

- Prefer Conventional Commit-style subjects such as `feat(oauth): ...` and `docs(gitbook): ...`.
- Pull requests must explain user-visible behavior, list verification steps, and link related issues.
- Include screenshots for dashboard changes.
- Call out environment or migration impact, especially changes involving `.env`, authentication, usage tracking, or provider automation.

## Upstream Sync Contracts

Upstream is `decolua/9router`; `origin` is the WYx0 fork. A fresh clone has no `upstream` remote, so add it before any sync work and keep it read-only:

```
git remote add upstream https://github.com/decolua/9router.git
git remote set-url --push upstream DISABLED
git fetch upstream --tags
```

### Fork Preservation Rule

- WYx0 features that upstream does not have are protected. No sync, port, conflict resolution, refactor, or cleanup may delete, disable, or silently narrow them.
- Removing or replacing a protected feature requires an explicit user decision, recorded in the owning `AGENTS.md` before the change lands.
- A sync is incomplete until every fork-only file that existed before the batch still exists, or its behavior demonstrably moved to a named replacement.

### Protected Fork Surface

Derive the current list rather than trusting a stored one; the areas below are durable, the file paths under them are not.

```
# fork-only files; every one must still be present after a sync batch
comm -23 <(git ls-tree -r --name-only HEAD | sort) \
         <(git ls-tree -r --name-only upstream/master | sort)
```

- Camoufox automation stack: `src/lib/oauth/services/automation/`, `automationBrowserLauncher.js`, every `*BulkImportManager`, the `/api/oauth/*/bulk-import` and `/api/tools/automation/cbcn/*` routes, and `/dashboard/automation`.
- CodeBuddy Global provider and its quota-cookie usage flow, including the CodeBuddy-aware paths inside `open-sse/executors/default.js` and the tiny-stream retry in `open-sse/handlers/chatCore.js`.
- CodeBuddy CN activation lifecycle, gateway-probation handling, and 5sim SMS registration.
- Proxy pool scraper with live verification before storage, plus bulk-import proxy resolution.
- Gemini Web provider and cookie auto-capture.
- Temp-mail allocation, IMAP OTP reading, and GitHub signup automation.
- Codex gateway account pinning, provider disable/availability utilities, connection bulk actions, and Quota Tracker pagination and display modes.
- `mergeAccountsAndProxyPoolsFromDb` merge-on-import behavior.
- WYx0 packaging and coexistence: package name `wyxrouter`, default port `20129`, isolated auth cookie names, and the `npm run wyx` fast runtime.
- This `AGENTS.md` hierarchy; upstream has no DOX files, so upstream-shaped trees never carry them.

### Sync Method

- Never run a wholesale `git merge upstream/master`. Port upstream work as selective per-commit cherry-picks or manual ports, in small reviewable batches.
- Triage each upstream commit before porting: security, isolated bugfix, feature overlapping WYx0 work, or fork metadata. Port security and isolated bugfixes first.
- When upstream and WYx0 implement the same capability, compare both and keep the better one. Where WYx0 is provider-aware and upstream is generic, keep WYx0 and port only the upstream delta that does not regress it.
- Resolve every conflicted hunk by reconstructing intent from both sides. Taking `--ours` or `--theirs` wholesale on a file that carries fork-only behavior is prohibited.
- Record deferred upstream items and the reason they are deferred, so a later session does not retry a known-bad port blindly.

### Known Collision Points

- `src/lib/oauth/providers.js`: upstream reduced it to a re-export and split the body into `src/lib/oauth/providers/`. WYx0 keeps the single-file implementation; a naive merge replaces it with a stub.
- `codebuddy-intl` and `tencent`: upstream's own CodeBuddy Global and Tencent providers overlap WYx0's `codebuddy` and `codebuddy-cn`. Keep the WYx0 providers and their aliases; do not let an upstream registry entry shadow them.
- `resolveTransport` and `runtimeTransport`: the upstream multi-endpoint transport refactor in `executors/default.js`, `handlers/chatCore.js`, and `services/provider.js` conflicts with WYx0's CodeBuddy-aware execution path, and blocks the Headroom proxy lifecycle port.
- `open-sse/providers/registry/index.js` is generated; regenerate it after a registry batch instead of merging it.

### Sync Verification

- Re-run the `comm -23` check above and account for every fork-only file that disappeared.
- Run the fork-only tests, not just the suite total; a batch that drops a WYx0 test file still reports green.
- Confirm the failing-file set is unchanged from the pre-batch baseline rather than assuming a clean run.

## Security Contracts

- Copy `.env.example` to `.env` for local setup; never commit real tokens, cookies, or exported local data.
- Treat `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, and provider credentials as sensitive.
- Disable verbose request logging unless actively debugging, and treat generated request logs as sensitive.
- Production launchers must load `custom-server.js` before the Next.js listener starts; only its per-process peer token makes `x-9r-real-ip` eligible for localhost trust.
- A fresh install using the built-in default password may authenticate locally only; remote login must fail without issuing a dashboard session until the password is configured.

## Child DOX Index

- `cli/AGENTS.md` - CLI runtime, packaging, postinstall behavior, terminal menus, and tray integration.
- `gitbook/AGENTS.md` - multilingual documentation site, navigation, content parity, and docs build.
- `open-sse/AGENTS.md` - provider execution, request orchestration, streaming, fallback, and format translation core.
- `scripts/AGENTS.md` - repository-level build, startup, fast runtime, and README translation scripts.
- `skills/AGENTS.md` - distributable 9Router agent skill documents.
- `src/AGENTS.md` - Next.js application, persistence, shared services, and the bridge into the routing core.
- `tests/AGENTS.md` - Vitest ownership, unit test conventions, translator coverage, and live-provider test boundaries.
