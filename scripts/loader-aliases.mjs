// Node ESM loader hook — resolves the "open-sse" jsconfig alias that
// Next.js webpack/Turbopack handles at build time but which is invisible
// to standalone Node runtime (used by CLI smoke scripts under scripts/).
//
// Usage:
//   node --loader ./scripts/loader-aliases.mjs scripts/test-github-signup-e2e.mjs
//
// The alias mirrors the paths block in ./jsconfig.json:
//   "open-sse":   ./open-sse/index.js  (bare specifier → package entry)
//   "open-sse/*": ./open-sse/*         (deep imports)

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function resolve(specifier, context, nextResolve) {
  // Bare specifier: "open-sse" → open-sse/index.js
  if (specifier === "open-sse") {
    return nextResolve(pathToFileURL(join(ROOT, "open-sse", "index.js")).href, context);
  }
  // Deep specifier: "open-sse/foo/bar.js" → ./open-sse/foo/bar.js
  if (specifier.startsWith("open-sse/")) {
    const rest = specifier.slice("open-sse/".length);
    return nextResolve(pathToFileURL(join(ROOT, "open-sse", rest)).href, context);
  }
  // Everything else: default resolution.
  return nextResolve(specifier, context);
}
