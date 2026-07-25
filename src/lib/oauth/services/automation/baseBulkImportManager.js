/**
 * BaseBulkImportManager — Shared automation base class for all provider bulk imports.
 *
 * Handles: job lifecycle, worker pool, account state machine, persistence,
 * browser preview capture, manual session management, cancel logic.
 *
 * Provider subclasses only need to implement:
 *   - processAccount(job, account, workerId) — the provider-specific automation flow
 *   - runManualFollowup(job, account, workerId, context, ...) — manual assist continuation
 *
 * Inspired by enowxai's modular adapter pattern (base.py + provider adapters).
 */
import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../../dataDir.js";
import { createAutomationBrowserLauncher } from "../automationBrowserLauncher.js";
import { DEFAULT_AUTOMATION_BROWSER, normalizeAutomationBrowser } from "../../../../shared/constants/automationBrowsers.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONCURRENCY = 4;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const MAX_ACCOUNT_LOG_ENTRIES = 40;
export const MAX_JOB_ACTIVITY_ENTRIES = 80;
export const PREVIEW_CAPTURE_INTERVAL_MS = 1500;
export const RECENT_TERMINAL_JOB_WINDOW_MS = 30 * 60_000;

export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "needs_manual"]);
export const TERMINAL_ACCOUNT_STATUSES = new Set([
  "success",
  "failed",
  "failed_invalid_credentials",
  "failed_exchange",
  "failed_timeout",
  "cancelled",
]);

// ── Camoufox Context ──────────────────────────────────────────────────────────

// Camoufox owns the browser fingerprint. Do not layer Chromium user-agent,
// viewport, or navigator patches over it: mixed fingerprints break its protocol
// compatibility and make the browser easier for login providers to detect.
export const AUTOMATION_CONTEXT_OPTIONS = {};
export const AUTOMATION_STEALTH_INIT_SCRIPT = "";

export async function createFreshContext(browser) {
  const context = await browser.newContext(AUTOMATION_CONTEXT_OPTIONS);
  const page = await context.newPage();
  return { context, page };
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function nowIso() {
  return new Date().toISOString();
}

export function clampConcurrency(value, {
  min = MIN_CONCURRENCY,
  max = MAX_CONCURRENCY,
  def = DEFAULT_CONCURRENCY,
} = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}

export function parseBulkAccounts(accounts = [], providerLabel = "provider") {
  const lines = Array.isArray(accounts) ? accounts : [];
  const parsed = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    const raw = String(line || "").trim();
    if (!raw) return;

    const [email = "", ...passwordParts] = raw.split("|");
    const normalizedEmail = email.trim();
    const normalizedPassword = passwordParts.join("|").trim();

    if (!normalizedEmail || !normalizedPassword) {
      invalidLines.push(index + 1);
      return;
    }

    parsed.push({
      line: index + 1,
      email: normalizedEmail,
      password: normalizedPassword,
    });
  });

  return { parsed, invalidLines };
}

export function createLogEntry(step, message, level = "info") {
  return {
    id: randomUUID(),
    at: nowIso(),
    step,
    message,
    level,
  };
}

// ── File Persistence Helpers ───────────────────────────────────────────────────

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
  try {
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
      throw error;
    }

    // Windows can reject atomic replacement while another process, an indexer,
    // or antivirus briefly holds the destination. copyFileSync still replaces
    // the contents without deleting the last valid snapshot first.
    fs.copyFileSync(tempFile, filePath);
    fs.unlinkSync(tempFile);
  }
}

export function getJobFile(jobId, dir) {
  ensureDir(dir);
  return path.join(dir, `${jobId}.json`);
}

export function readPersistedLatestJobId(metaFile) {
  return readJsonFile(metaFile)?.latestJobId || null;
}

export function writePersistedLatestJobId(jobId, metaFile) {
  writeJsonFile(metaFile, { latestJobId: jobId || null, updatedAt: nowIso() });
}

// ── Summary & Sanitization ─────────────────────────────────────────────────────

function getFailedCount(accounts) {
  return accounts.filter((a) => (
    a.status === "failed"
    || a.status === "failed_invalid_credentials"
    || a.status === "failed_exchange"
    || a.status === "failed_timeout"
  )).length;
}

export function buildSummary(accounts) {
  return {
    total: accounts.length,
    queued: accounts.filter((a) => a.status === "queued").length,
    running: accounts.filter((a) => a.status === "running").length,
    success: accounts.filter((a) => a.status === "success").length,
    failed: getFailedCount(accounts),
    needs_manual: accounts.filter((a) => a.status === "needs_manual").length,
    cancelled: accounts.filter((a) => a.status === "cancelled").length,
  };
}

export function hasUnfinishedAccounts(accounts) {
  return accounts.some((a) => (
    a.status === "queued" || a.status === "running" || a.status === "needs_manual"
  ));
}

function appendAccountLog(account, step, message, level = "info") {
  const entry = createLogEntry(step, message, level);
  account.currentStep = step;
  account.updatedAt = entry.at;
  account.logs = account.logs || [];
  account.logs.push(entry);
  if (account.logs.length > MAX_ACCOUNT_LOG_ENTRIES) {
    account.logs.splice(0, account.logs.length - MAX_ACCOUNT_LOG_ENTRIES);
  }
  return entry;
}

function buildJobActivity(accounts) {
  return accounts
    .flatMap((account) => (account.logs || []).map((entry) => ({
      ...entry,
      email: account.email,
      line: account.line,
      workerId: account.workerId || null,
      status: account.status,
    })))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(-MAX_JOB_ACTIVITY_ENTRIES);
}

export function sanitizeAccount(account) {
  return {
    email: account.email,
    status: account.status,
    error: account.error || null,
    connectionId: account.connectionId || null,
    workerId: account.workerId || null,
    line: account.line,
    currentStep: account.currentStep || null,
    updatedAt: account.updatedAt || null,
    logs: (account.logs || []).slice(-8),
    manualSessionAvailable: Boolean(account.manualSession?.page) && account.status === "needs_manual",
    manualSessionOpened: Boolean(account.manualSession?.opened),
  };
}

export function sanitizeJob(job, extras = {}) {
  return {
    jobId: job.jobId,
    status: job.status,
    summary: buildSummary(job.accounts),
    concurrency: job.concurrency,
    browser: job.browserChoice || DEFAULT_AUTOMATION_BROWSER,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    accounts: job.accounts.map(sanitizeAccount),
    activity: buildJobActivity(job.accounts),
    error: job.error || null,
    preview: extras.preview || null,
  };
}

export function buildPersistedSnapshot(job) {
  return sanitizeJob(job, { preview: job.lastPreview || null });
}

function normalizePersistedJobSnapshot(job) {
  if (!job?.preview) return job || null;
  const hasPreviewableAccount = (job.accounts || []).some((account) => (
    account.status === "running" || account.status === "needs_manual"
  ));
  if (hasPreviewableAccount) return job;
  return { ...job, preview: null };
}

export function isRecentTerminalJob(job) {
  if (!job || ACTIVE_JOB_STATUSES.has(job.status)) return false;
  const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  if (!Number.isFinite(finishedAtMs)) return false;
  return (Date.now() - finishedAtMs) <= RECENT_TERMINAL_JOB_WINDOW_MS;
}

export function buildLookupResponse(job, extras = {}) {
  if (!job) {
    return { found: false, stale: Boolean(extras.stale), recoverable: false, job: null };
  }
  return {
    found: true,
    stale: false,
    recoverable: ACTIVE_JOB_STATUSES.has(job.status) || isRecentTerminalJob(job),
    job,
  };
}

function cancelPersistedActiveJob(job) {
  if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) return job || null;

  const cancelledAt = nowIso();
  const accounts = (job.accounts || []).map((account) => {
    if (!ACTIVE_JOB_STATUSES.has(account.status)) return account;
    return {
      ...account,
      status: "cancelled",
      error: account.error || "Job cancelled",
      currentStep: "cancelled",
      updatedAt: cancelledAt,
      logs: [
        ...(account.logs || []),
        createLogEntry("cancelled", "Job cancelled after the worker session was no longer active"),
      ].slice(-MAX_ACCOUNT_LOG_ENTRIES),
      manualSessionAvailable: false,
    };
  });

  return sanitizeJob({
    ...job,
    status: "cancelled",
    finishedAt: job.finishedAt || cancelledAt,
    accounts,
  });
}

// ── Browser Window Helpers ─────────────────────────────────────────────────────

async function revealBrowserWindow(page) {
  if (!page) return false;

  try {
    const context = page.context?.();
    if (!context?.newCDPSession) {
      await page.bringToFront?.().catch(() => null);
      return true;
    }

    const session = await context.newCDPSession(page);
    let windowId = null;

    try {
      const targetInfo = await session.send("Target.getTargetInfo");
      const targetId = targetInfo?.targetInfo?.targetId;
      const windowInfo = await session.send("Browser.getWindowForTarget", targetId ? { targetId } : {});
      windowId = windowInfo?.windowId ?? null;
    } catch {
      windowId = null;
    }

    if (windowId != null) {
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal", left: 80, top: 80, width: 1280, height: 960 },
      }).catch(() => null);
    }

    await page.bringToFront?.().catch(() => null);
    await session.detach?.().catch(() => null);
    return true;
  } catch {
    await page.bringToFront?.().catch(() => null);
    return true;
  }
}

// ── Default Browser Launcher ───────────────────────────────────────────────────

async function defaultBrowserLauncher(browser = DEFAULT_AUTOMATION_BROWSER, options = {}) {
  return await createAutomationBrowserLauncher(browser, {
    headless: options.headless !== false,
    proxy: options.proxy || null,
    // Only forward humanize when the caller explicitly set it — omitting
    // the key entirely preserves the historical Camoufox default for the
    // legacy flows that do not need extra behavioral mimicry.
    ...(options.humanize === true ? { humanize: true } : {}),
  })();
}

// ── Base Class ─────────────────────────────────────────────────────────────────

/**
 * BaseBulkImportManager — provider-agnostic job orchestration.
 *
 * Subclass contract:
 *   - Override `processAccount(job, account, workerId)` with provider-specific automation
 *   - Override `runManualFollowup(job, account, workerId, context, ...)` with provider-specific manual flow
 *   - Pass `storageName` and `providerLabel` in constructor options
 */
export class BaseBulkImportManager {
  constructor({
    storageName,
    providerLabel = "provider",
    browserLauncher = defaultBrowserLauncher,
    browserPerAccount = false,
    defaultConcurrency = DEFAULT_CONCURRENCY,
  } = {}) {
    if (!storageName) throw new Error("BaseBulkImportManager requires a storageName");

    this.providerLabel = providerLabel;
    this.browserLauncher = browserLauncher;
    this.browserPerAccount = browserPerAccount;
    this.defaultConcurrency = defaultConcurrency;
    this.storageDir = path.join(DATA_DIR, storageName);
    this.metaFile = path.join(this.storageDir, "meta.json");
    this.jobs = new Map();
    this.latestJobId = readPersistedLatestJobId(this.metaFile);
  }

  // ── Job Lifecycle ────────────────────────────────────────────────────────

  startJob({ parsedAccounts, concurrency, browser, browserLaunchOptions = null, prelaunchedBrowsers = null }) {
    if (!parsedAccounts.length) {
      throw Object.assign(new Error("At least one account entry is required"), { error: "At least one account entry is required" });
    }

    const jobId = randomUUID();
    const createdAt = nowIso();
    const browserChoice = normalizeAutomationBrowser(browser);
    const job = {
      jobId,
      status: "running",
      concurrency: clampConcurrency(concurrency, { def: this.defaultConcurrency }),
      browserChoice,
      browserLaunchOptions,
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      error: null,
      cancelRequested: false,
      browser: null,
      activeBrowsers: new Set(),
      prelaunchedBrowsers: prelaunchedBrowsers || new Map(),
      nextIndex: 0,
      manualFollowups: new Set(),
      persistPromise: Promise.resolve(),
      lastPreview: null,
      lastPreviewCapturedAt: 0,
      accounts: parsedAccounts.map((account) => ({
        line: account.line,
        email: account.email,
        password: account.password,
        status: "queued",
        error: null,
        connectionId: null,
        workerId: null,
        manualSession: null,
        runtimeSession: null,
        currentStep: "queued",
        updatedAt: createdAt,
        logs: [createLogEntry("queued", "Queued and waiting for an available worker")],
      })),
    };

    this.jobs.set(jobId, job);
    this.latestJobId = jobId;
    writePersistedLatestJobId(jobId, this.metaFile);
    void this.persistJobSnapshot(job, { forcePreview: false });
    void this.runJob(jobId);
    return sanitizeJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job) return sanitizeJob(job, { preview: job.lastPreview || null });
    return normalizePersistedJobSnapshot(readJsonFile(getJobFile(jobId, this.storageDir)));
  }

  async getJobWithPreview(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return normalizePersistedJobSnapshot(readJsonFile(getJobFile(jobId, this.storageDir)));
    const preview = await this.capturePreview(job);
    job.lastPreview = preview || job.lastPreview || null;
    // Status polling is a read path. A transient Windows file lock must not turn
    // a valid job response into HTTP 500 merely because preview persistence failed.
    await this.persistJobSnapshot(job, { forcePreview: false }).catch(() => null);
    return sanitizeJob(job, { preview: job.lastPreview || null });
  }

  async getLatestJobWithPreview({ includeRecentTerminal = false } = {}) {
    const latestJobId = this.latestJobId || readPersistedLatestJobId(this.metaFile);
    if (!latestJobId) return null;
    const job = await this.getJobWithPreview(latestJobId);
    if (!job) return null;
    if (ACTIVE_JOB_STATUSES.has(job.status)) return job;
    if (includeRecentTerminal && isRecentTerminalJob(job)) return job;
    return null;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      const jobFile = getJobFile(jobId, this.storageDir);
      const persistedJob = readJsonFile(jobFile);
      const cancelledJob = cancelPersistedActiveJob(persistedJob);
      if (cancelledJob && cancelledJob !== persistedJob) {
        writeJsonFile(jobFile, cancelledJob);
      }
      return cancelledJob;
    }

    job.cancelRequested = true;
    const activeAccounts = job.accounts.filter((account) => ACTIVE_JOB_STATUSES.has(account.status));
    if (activeAccounts.length > 0) {
      job.status = "cancelled";
      job.finishedAt = nowIso();
      activeAccounts.forEach((account) => {
        this.finalizeAccount(account, "cancelled", {
          error: "Job cancelled",
          step: "cancelled",
          message: "Job cancelled before completion",
        });
      });
    }

    if (job.browser) {
      void job.browser.close().catch(() => null);
      job.browser = null;
    }
    for (const browser of job.activeBrowsers || []) {
      void browser.close().catch(() => null);
    }
    job.activeBrowsers?.clear();

    void this.persistJobSnapshot(job, { forcePreview: true });
    return sanitizeJob(job);
  }

  // ── Manual Session ───────────────────────────────────────────────────────

  async openManualSession(jobId, workerId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const numericWorkerId = Number.parseInt(workerId, 10);
    const account = job.accounts.find((entry) => (
      entry.workerId === numericWorkerId
      && entry.status === "needs_manual"
      && entry.manualSession?.page
    ));

    if (!account) {
      return { ok: false, error: "Manual session not found for this worker", job: sanitizeJob(job) };
    }

    const opened = await revealBrowserWindow(account.manualSession.page);
    account.manualSession.opened = opened;
    account.manualSession.openedAt = opened
      ? (account.manualSession.openedAt || nowIso())
      : account.manualSession.openedAt || null;
    await this.persistJobSnapshot(job, { forcePreview: true });

    return { ok: true, job: sanitizeJob(job), account: sanitizeAccount(account) };
  }

  // ── Account State Machine ────────────────────────────────────────────────

  dequeueAccount(job, workerId) {
    while (job.nextIndex < job.accounts.length) {
      const account = job.accounts[job.nextIndex];
      job.nextIndex += 1;
      if (account.status !== "queued") continue;
      account.status = "running";
      account.workerId = workerId;
      account.error = null;
      appendAccountLog(account, "worker_assigned", `Worker ${workerId} picked up this account`);
      void this.persistJobSnapshot(job, { forcePreview: false });
      return account;
    }
    return null;
  }

  finalizeAccount(account, status, extras = {}) {
    if (account.status === "cancelled" && status !== "cancelled") return account;
    account.status = status;
    account.error = extras.error || null;
    account.connectionId = extras.connectionId || null;
    if (extras.step || extras.message) {
      appendAccountLog(
        account,
        extras.step || status,
        extras.message || extras.error || status.replaceAll("_", " ")
      );
    }
    return account;
  }

  setAccountStep(account, step, message, level = "info") {
    if (account.status === "cancelled") return null;
    appendAccountLog(account, step, message, level);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async persistJobSnapshot(job, { forcePreview = false } = {}) {
    if (!job) return;

    const runPersist = async () => {
      const shouldCapturePreview = forcePreview || (Date.now() - (job.lastPreviewCapturedAt || 0) >= PREVIEW_CAPTURE_INTERVAL_MS);
      if (shouldCapturePreview) {
        const preview = await this.capturePreview(job);
        job.lastPreview = preview || null;
        job.lastPreviewCapturedAt = Date.now();
      }
      writeJsonFile(getJobFile(job.jobId, this.storageDir), buildPersistedSnapshot(job));
    };

    job.persistPromise = Promise.resolve(job.persistPromise).catch(() => null).then(runPersist);
    await job.persistPromise;
  }

  async capturePreview(job) {
    const previewAccount = job.accounts.find((a) => a.status === "running" && a.runtimeSession?.page)
      || job.accounts.find((a) => a.status === "needs_manual" && a.manualSession?.page);

    if (!previewAccount) return null;

    const page = previewAccount.runtimeSession?.page || previewAccount.manualSession?.page;
    if (!page) return null;

    try {
      const screenshot = await page.screenshot({
        type: "jpeg", quality: 55, fullPage: false,
        animations: "disabled", caret: "hide",
      });
      return {
        email: previewAccount.email,
        workerId: previewAccount.workerId || null,
        status: previewAccount.status,
        step: previewAccount.currentStep || null,
        updatedAt: previewAccount.updatedAt || nowIso(),
        imageData: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
      };
    } catch {
      return {
        email: previewAccount.email,
        workerId: previewAccount.workerId || null,
        status: previewAccount.status,
        step: previewAccount.currentStep || null,
        updatedAt: previewAccount.updatedAt || nowIso(),
        imageData: null,
      };
    }
  }

  // ── Worker Pool ──────────────────────────────────────────────────────────

  async runWorker(job, workerId) {
    while (!job.cancelRequested) {
      const account = this.dequeueAccount(job, workerId);
      if (!account) return;

      let accountBrowser = job.browser;
      try {
        if (this.browserPerAccount) {
          accountBrowser = job.prelaunchedBrowsers?.get(account.line) || null;
          job.prelaunchedBrowsers?.delete(account.line);
          if (!accountBrowser) {
            const launchOptions = typeof job.browserLaunchOptions === "function"
              ? await job.browserLaunchOptions({ job, account, workerId })
              : (job.browserLaunchOptions || {});
            accountBrowser = await this.browserLauncher(
              job.browserChoice || DEFAULT_AUTOMATION_BROWSER,
              launchOptions
            );
          }
          if (job.cancelRequested) {
            await accountBrowser.close().catch(() => null);
            return;
          }
          job.activeBrowsers.add(accountBrowser);
        }
        await this.processAccount(job, account, workerId, accountBrowser);
      } catch (error) {
        if (account.status === "queued" || account.status === "running") {
          this.finalizeAccount(account, "failed", {
            error: error.message || "Bulk-import worker failed.",
            step: "worker_failed",
            message: error.message || "Bulk-import worker failed.",
          });
          account.password = undefined;
          await this.persistJobSnapshot(job, { forcePreview: true });
        }
      } finally {
        if (this.browserPerAccount && accountBrowser && account.status !== "needs_manual") {
          await accountBrowser.close().catch(() => null);
          job.activeBrowsers.delete(accountBrowser);
        }
      }
    }
  }

  async runJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      if (!this.browserPerAccount) {
        job.browser = await this.browserLauncher(
          job.browserChoice || DEFAULT_AUTOMATION_BROWSER,
          job.browserLaunchOptions || {}
        );
      }
      job.accounts.forEach((account) => {
        if (account.status === "queued" && (account.logs || []).length === 1) {
          this.setAccountStep(account, "waiting_for_worker", "Waiting for a free worker");
        }
      });
      await this.persistJobSnapshot(job, { forcePreview: false });

      const workerCount = Math.min(job.concurrency, Math.max(job.accounts.length, 1));
      const workers = Array.from({ length: workerCount }, (_, index) => this.runWorker(job, index + 1));
      const workerResults = await Promise.allSettled(workers);

      const workerFailure = workerResults.find((result) => result.status === "rejected");
      if (workerFailure) {
        const error = workerFailure.reason?.message || "A bulk-import worker stopped unexpectedly.";
        job.accounts.forEach((account) => {
          if (account.status === "queued" || account.status === "running") {
            this.finalizeAccount(account, "failed", {
              error,
              step: "worker_failed",
              message: error,
            });
            account.password = undefined;
          }
        });
      }

      if (job.manualFollowups.size > 0) {
        await Promise.allSettled([...job.manualFollowups]);
      }

      if (job.cancelRequested) {
        job.accounts.forEach((account) => {
          if (ACTIVE_JOB_STATUSES.has(account.status)) {
            this.finalizeAccount(account, "cancelled", {
              error: "Job cancelled",
              step: "cancelled",
              message: "Job cancelled before completion",
            });
          }
        });
        job.status = job.accounts.some((account) => account.status === "cancelled")
          ? "cancelled"
          : "completed";
      } else {
        job.status = "completed";
      }
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      job.status = "failed";
      job.error = error.message || `Failed to start ${this.providerLabel} bulk import job.`;
      job.accounts.forEach((account) => {
        if (account.status === "queued" || account.status === "running") {
          this.finalizeAccount(account, "failed", {
            error: job.error,
            step: "failed",
            message: job.error,
          });
          account.password = undefined;
        }
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      if (job.browser) {
        await job.browser.close().catch(() => null);
        job.browser = null;
      }
      for (const browser of job.activeBrowsers || []) {
        await browser.close().catch(() => null);
      }
      job.activeBrowsers?.clear();
      job.finishedAt = nowIso();
      await this.persistJobSnapshot(job, { forcePreview: true });
    }
  }

  // ── Provider-specific (override in subclass) ─────────────────────────────

  async processAccount(job, account, workerId) {
    throw new Error(`processAccount not implemented for ${this.providerLabel}`);
  }

  async runManualFollowup(job, account, workerId, context, ...args) {
    throw new Error(`runManualFollowup not implemented for ${this.providerLabel}`);
  }
}
