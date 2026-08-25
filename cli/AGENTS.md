# CLI Package

## Purpose

- Own the distributable `wyxrouter` command, terminal menus, server lifecycle, runtime dependency setup, tray integration, and CLI bundle packaging.

## Ownership

- `cli.js` is the command entry point.
- `src/cli/` owns API clients, menus, terminal UI, tray behavior, and CLI utilities.
- `hooks/` owns postinstall and runtime dependency preparation.
- `scripts/` owns the esbuild-based CLI packaging pipeline.
- Generated bundle output under `app/` is build output; change its source or build process rather than hand-editing generated files.

## Local Contracts

- Preserve Node 18 compatibility and cross-platform Windows, macOS, and Linux behavior.
- Keep runtime data and lazily installed native dependencies outside the globally installed package as established by the package comments.
- Avoid interactive prompts when explicit CLI flags already provide the needed value.
- Keep startup, browser opening, updates, tray behavior, and shutdown predictable in both interactive and headless use.
- Treat `custom-server.js` as a required package artifact and start through it so socket-derived peer headers cannot be spoofed; packaging must fail when the wrapper is absent. Upstream falls back to a bare `server.js`; that fallback must not be ported back.
- Gate post-start work on `waitServerReady`, a TCP poll against the bound port, rather than a fixed delay; the update check runs in parallel and is awaited only where the version is actually displayed.
- Kill MITM and tunnel processes off the critical path. They hold separate ports, so removing them never frees the app port, and the server-side MITM manager recovers stale locks on its own.
- The default port is `20129` and the package identity is `wyxrouter` throughout `cli.js`, `src/cli/api/client.js`, and the menus. Upstream uses `20128` and `9router`; never adopt those values during a sync.
- `hooks/sqliteRuntime.js` keeps the parent `node_modules` entry in `NODE_PATH`, which a global install needs; upstream has no such entry.

## Work Guidance

- Use existing terminal UI and menu helpers for prompts and display formatting.
- Keep platform-specific tray and autostart logic isolated.
- Update package file lists when adding files required at runtime.

## Verification

- Run `npm --prefix cli run build`.
- For packaging changes, run `npm run cli:pack` from the repository root.
- Smoke-test relevant CLI flags when startup or argument parsing changes.

## Child DOX Index

- No child DOX files are currently defined; this file owns the full `cli` subtree.
