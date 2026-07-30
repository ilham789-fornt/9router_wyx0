// Global setup for Vitest unit tests.
//
// This file is loaded before any test runs. It flips the automation runtime
// into "fast mode" so googleOAuth's human-cadence delays (per-key jitter,
// pre-submit pause, focus settle) collapse to zero. Real bulk workers never
// import this file, so production still gets the full anti-bot delays that
// defeat Google's "Something went wrong" (出了点问题) heuristic.
globalThis.__automationFastMode = true;
