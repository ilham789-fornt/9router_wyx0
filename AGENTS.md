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
- Automation jobs built on `BaseBulkImportManager` whose accounts all fail expose a failed top-level status rather than reporting completion.
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

## Security Contracts

- Copy `.env.example` to `.env` for local setup; never commit real tokens, cookies, or exported local data.
- Treat `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, and provider credentials as sensitive.
- Disable verbose request logging unless actively debugging, and treat generated request logs as sensitive.

## Child DOX Index

- `cli/AGENTS.md` - CLI runtime, packaging, postinstall behavior, terminal menus, and tray integration.
- `gitbook/AGENTS.md` - multilingual documentation site, navigation, content parity, and docs build.
- `open-sse/AGENTS.md` - provider execution, request orchestration, streaming, fallback, and format translation core.
- `scripts/AGENTS.md` - repository-level build, startup, fast runtime, and README translation scripts.
- `skills/AGENTS.md` - distributable 9Router agent skill documents.
- `src/AGENTS.md` - Next.js application, persistence, shared services, and the bridge into the routing core.
- `tests/AGENTS.md` - Vitest ownership, unit test conventions, translator coverage, and live-provider test boundaries.
