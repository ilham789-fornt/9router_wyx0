"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import PropTypes from "prop-types";
import Badge from "./Badge";
import Button from "./Button";
import Input from "./Input";
import Modal from "./Modal";
import { DEFAULT_AUTOMATION_BROWSER } from "@/shared/constants/automationBrowsers";
import { useNotificationStore } from "@/store/notificationStore";

const DEFAULT_CONCURRENCY = 4;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "needs_manual"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Sentinel values for the proxy-pool select. Kept in sync with the server-side
// resolver (`AUTO_PROXY_POOL_ID` in bulkImportProxyResolver.js) and the
// "no proxy" contract (empty string → server treats it as null → direct
// browser launch, no outbound proxy).
const AUTO_PROXY_POOL_ID = "__auto__";
const NONE_PROXY_POOL_ID = "";

function getRecommendedConcurrency({ defaultConcurrency, maxConcurrency }) {
  if (typeof navigator === "undefined") {
    return {
      value: Math.min(maxConcurrency, Math.max(1, defaultConcurrency)),
      details: "Browser fallback until server capacity is available.",
      source: "browser",
    };
  }

  const cores = Number(navigator.hardwareConcurrency) || 4;
  const memory = Number(navigator.deviceMemory) || null;
  const isMobile = Boolean(navigator.userAgentData?.mobile) || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "");
  const cpuLimit = cores >= 12 ? 6 : cores >= 8 ? 4 : cores >= 4 ? 3 : 1;
  const memoryLimit = memory === null ? cpuLimit : memory >= 16 ? 6 : memory >= 8 ? 4 : memory >= 4 ? 3 : 1;
  const mobileLimit = isMobile ? 2 : maxConcurrency;
  const value = Math.min(maxConcurrency, mobileLimit, Math.max(1, Math.min(cpuLimit, memoryLimit)));
  const memoryLabel = memory ? `${memory}GB RAM` : "unknown RAM";

  return {
    value,
    details: `Browser fallback: ${cores} CPU thread${cores === 1 ? "" : "s"}, ${memoryLabel}${isMobile ? ", mobile device" : ""}.`,
    source: "browser",
  };
}

function getServerRecommendedConcurrency(data, maxConcurrency, fallback) {
  const cpuThreads = Number(data?.cpuThreads) || null;
  const totalMemoryGb = Number(data?.totalMemoryGb) || null;
  const recommendedWorkers = Number(data?.recommendedWorkers);
  if (!Number.isFinite(recommendedWorkers) || recommendedWorkers <= 0) return fallback;
  const value = Math.min(maxConcurrency, Math.max(1, recommendedWorkers));
  const cpuLabel = cpuThreads ? `${cpuThreads} CPU thread${cpuThreads === 1 ? "" : "s"}` : "unknown CPU";
  const memoryLabel = totalMemoryGb ? `${totalMemoryGb}GB RAM` : "unknown RAM";
  return {
    value,
    details: `Server capacity: ${cpuLabel}, ${memoryLabel}.`,
    source: "server",
  };
}

function formatStepLabel(value) {
  return String(value || "waiting").replaceAll("_", " ");
}

function formatClock(value) {
  if (!value) return "now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getStatusVariant(status) {
  if (status === "success" || status === "completed") return "success";
  if (status === "needs_manual") return "warning";
  if (status === "running" || status === "queued") return "info";
  if (status === "cancelled") return "default";
  return "danger";
}

function getJobOutcome(job) {
  const summary = job?.summary || {};
  const successCount = Number(summary.success || 0);
  const failedCount = Number(summary.failed || 0)
    + Number(summary.failed_invalid_credentials || 0)
    + Number(summary.failed_exchange || 0)
    + Number(summary.failed_timeout || 0);
  const manualCount = Number(summary.needs_manual || 0);
  const cancelledCount = Number(summary.cancelled || 0);
  return { successCount, failedCount, manualCount, cancelledCount };
}

function notifyJobFinished(notify, serviceName, job) {
  const { successCount, failedCount, manualCount, cancelledCount } = getJobOutcome(job);
  const details = [
    `Saved ${successCount} account${successCount === 1 ? "" : "s"}`,
    failedCount ? `failed ${failedCount}` : null,
    manualCount ? `manual ${manualCount}` : null,
    cancelledCount ? `cancelled ${cancelledCount}` : null,
  ].filter(Boolean).join(", ");

  if (job?.status === "completed") {
    notify.success(`${serviceName} bulk import completed. ${details}.`, "Bulk Import Done");
  } else if (job?.status === "cancelled") {
    notify.warning(`${serviceName} bulk import cancelled. ${details}.`, "Bulk Import Cancelled");
  } else {
    notify.error(`${serviceName} bulk import failed. ${details}.`, "Bulk Import Failed");
  }
}

function AccountStatusBadge({ status }) {
  return (
    <Badge variant={getStatusVariant(status)} size="sm">
      {formatStepLabel(status)}
    </Badge>
  );
}

AccountStatusBadge.propTypes = {
  status: PropTypes.string,
};

function getResponseHeader(response, name) {
  return response?.headers?.get?.(name) || "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNonJsonError(response, text, fallbackMessage) {
  const status = response?.status;
  const statusText = response?.statusText ? ` ${response.statusText}` : "";
  const prefix = status ? `${fallbackMessage} (${status}${statusText})` : fallbackMessage;
  const detail = stripHtml(text).slice(0, 180);
  return detail ? `${prefix}: ${detail}` : prefix;
}

async function readBulkApiResponse(response, fallbackMessage = "Bulk request failed") {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const contentType = getResponseHeader(response, "content-type");
    const isHtml = contentType.includes("text/html") || text.trim().startsWith("<");
    return {
      error: isHtml
        ? buildNonJsonError(response, text, fallbackMessage)
        : `${fallbackMessage}: server returned malformed JSON`,
    };
  }
}

async function fetchJob(provider, jobId) {
  const res = await fetch(`/api/oauth/${provider}/bulk-import/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  const data = await readBulkApiResponse(res, "Failed to load bulk job");
  return { res, data };
}

async function fetchLatestJob(provider, scope = "recoverable") {
  const res = await fetch(`/api/oauth/${provider}/bulk-import/latest?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
  const data = await readBulkApiResponse(res, "Failed to load latest bulk job");
  return { res, data };
}

export default function BulkAccountAutomationModal({
  isOpen,
  onClose,
  onSuccess,
  provider,
  title,
  serviceName,
  defaultConcurrency = DEFAULT_CONCURRENCY,
  maxConcurrency = 8,
  accountFormat = "gmail|password",
  introText,
  enableProxyPool = false,
  // When true, the operator must pick a real pool (or Auto pool). Used by
  // CodeBuddy GSuite bulk which physically requires one unique proxy per
  // worker. When false (default when enableProxyPool is on), the operator
  // may pick "None (direct)" and the workers launch without a proxy.
  requireProxyPool = false,
}) {
  const storageKey = `${provider}-bulk-import-active-job`;
  const notify = useNotificationStore();
  const completedRefreshJobsRef = useRef(new Set());
  const [bulkText, setBulkText] = useState("");
  const fallbackRecommendation = useMemo(() => getRecommendedConcurrency({ defaultConcurrency, maxConcurrency }), [defaultConcurrency, maxConcurrency]);
  const [concurrency, setConcurrency] = useState(() => String(getRecommendedConcurrency({ defaultConcurrency, maxConcurrency }).value));
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [proxyPools, setProxyPools] = useState([]);
  // Default: "Auto pool" when the flow requires a proxy, "None (direct)"
  // otherwise. Both stay valid whether pools are loaded yet or not, so the
  // start button never blocks on the async pool fetch.
  const [proxyPoolId, setProxyPoolId] = useState(() => (
    requireProxyPool ? AUTO_PROXY_POOL_ID : NONE_PROXY_POOL_ID
  ));
  const [jobRestoreNotice, setJobRestoreNotice] = useState(null);
  const browserChoice = DEFAULT_AUTOMATION_BROWSER;
  const runningJob = activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status);
  const finishedJob = activeJob && TERMINAL_JOB_STATUSES.has(activeJob.status);

  const groupedAccounts = useMemo(() => {
    const groups = new Map();
    for (const account of activeJob?.accounts || []) {
      const key = account.status || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(account);
    }
    return [...groups.entries()].map(([status, accounts]) => ({ status, accounts }));
  }, [activeJob]);

  const activityItems = useMemo(() => (
    [...(activeJob?.activity || [])].reverse()
  ), [activeJob]);

  const [recommendedConcurrency, setRecommendedConcurrency] = useState(fallbackRecommendation);

  useEffect(() => {
    let cancelled = false;
    const loadCapacity = async () => {
      try {
        const res = await fetch("/api/system/capacity", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const next = getServerRecommendedConcurrency(data, maxConcurrency, fallbackRecommendation);
        setRecommendedConcurrency(next);
        setConcurrency((current) => {
          if (!current || current === String(defaultConcurrency) || current === String(fallbackRecommendation.value)) return String(next.value);
          return current;
        });
      } catch {
        if (!cancelled) setRecommendedConcurrency(fallbackRecommendation);
      }
    };
    void loadCapacity();
    return () => { cancelled = true; };
  }, [defaultConcurrency, fallbackRecommendation, maxConcurrency]);

  useEffect(() => {
    if (!isOpen || !enableProxyPool) return undefined;
    let cancelled = false;
    fetch("/api/proxy-pools?view=options&isActive=true", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const pools = (Array.isArray(data) ? data : data?.proxyPools || data?.pools || [])
          .filter((pool) => pool?.isActive !== false && !["vercel", "cloudflare", "deno"].includes(pool?.type));
        setProxyPools(pools);
        // Keep Auto/None sentinels intact. Only fall back to the first pool
        // when the flow requires a proxy AND the current selection points to
        // a specific pool that no longer exists in the loaded list.
        setProxyPoolId((current) => {
          if (current === AUTO_PROXY_POOL_ID) return current;
          if (current === NONE_PROXY_POOL_ID) {
            return requireProxyPool && pools.length ? pools[0].id : NONE_PROXY_POOL_ID;
          }
          const stillExists = pools.some((pool) => pool.id === current);
          if (stillExists) return current;
          return requireProxyPool
            ? (pools[0]?.id || AUTO_PROXY_POOL_ID)
            : NONE_PROXY_POOL_ID;
        });
      })
      .catch(() => {
        if (!cancelled) setProxyPools([]);
      });
    return () => { cancelled = true; };
  }, [enableProxyPool, isOpen, requireProxyPool]);

  const resetState = useCallback(() => {
    setBulkText("");
    setConcurrency(String(recommendedConcurrency.value));
    setActiveJob(null);
    setError(null);
    setImporting(false);
    setJobRestoreNotice(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey);
    }
  }, [recommendedConcurrency.value, storageKey]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const restore = async () => {
      setError(null);
      setJobRestoreNotice(null);
      try {
        const storedJobId = typeof window !== "undefined"
          ? window.localStorage.getItem(storageKey)
          : null;
        if (storedJobId) {
          const { res, data } = await fetchJob(provider, storedJobId);
          if (!cancelled && res.ok && data?.job && data.recoverable) {
            setActiveJob(data.job);
            setJobRestoreNotice("Restored the active bulk login job.");
            return;
          }
        }

        const latest = await fetchLatestJob(provider);
        if (!cancelled && latest.res.ok && latest.data?.job) {
          setActiveJob(latest.data.job);
          setJobRestoreNotice("Restored the latest recoverable bulk login job.");
          if (typeof window !== "undefined") {
            window.localStorage.setItem(storageKey, latest.data.job.jobId);
          }
        }
      } catch {
        if (!cancelled) setJobRestoreNotice(null);
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [isOpen, provider, storageKey]);

  useEffect(() => {
    if (!isOpen || !activeJob?.jobId || finishedJob) return undefined;

    const interval = window.setInterval(async () => {
      try {
        const { res, data } = await fetchJob(provider, activeJob.jobId);
        if (res.ok && data?.job) {
          setActiveJob(data.job);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(storageKey, data.job.jobId);
          }
          if (TERMINAL_JOB_STATUSES.has(data.job.status) && !completedRefreshJobsRef.current.has(data.job.jobId)) {
            completedRefreshJobsRef.current.add(data.job.jobId);
            notifyJobFinished(notify, serviceName, data.job);
            onSuccess?.();
          }
        }
      } catch {
        // Keep the current snapshot visible; the next interval can recover.
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [activeJob?.jobId, finishedJob, isOpen, notify, onSuccess, provider, serviceName, storageKey]);

  const handleStartBulk = async () => {
    const lines = bulkText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      setError("Please enter at least one gmail|password line");
      return;
    }

    setImporting(true);
    setError(null);
    setJobRestoreNotice(null);

    try {
      const res = await fetch(`/api/oauth/${provider}/bulk-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: lines,
          concurrency: Number.parseInt(concurrency, 10) || defaultConcurrency,
          browser: browserChoice,
          ...(enableProxyPool ? { proxyPoolId } : {}),
        }),
      });
      const data = await readBulkApiResponse(res, "Bulk account import failed");
      if (!res.ok) {
        const invalidHint = Array.isArray(data.invalidLines) && data.invalidLines.length > 0
          ? ` Invalid lines: ${data.invalidLines.join(", ")}`
          : "";
        throw new Error((data.error || "Bulk account import failed") + invalidHint);
      }

      setActiveJob(data.job || null);
      if (data.job?.jobId) {
        completedRefreshJobsRef.current.delete(data.job.jobId);
        if (typeof window !== "undefined") window.localStorage.setItem(storageKey, data.job.jobId);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob?.jobId) return;

    try {
      const res = await fetch(`/api/oauth/${provider}/bulk-import/${encodeURIComponent(activeJob.jobId)}/cancel`, {
        method: "POST",
      });
      const data = await readBulkApiResponse(res, "Failed to cancel job");
      if (!res.ok) {
        if (res.status === 404 && typeof window !== "undefined") {
          window.localStorage.removeItem(storageKey);
        }
        if (res.status === 404) setActiveJob(null);
        throw new Error(data.error || "Failed to cancel job");
      }
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleOpenManualSession = async (workerId) => {
    if (!activeJob?.jobId || !workerId) return;

    try {
      const res = await fetch(`/api/oauth/${provider}/bulk-import/${encodeURIComponent(activeJob.jobId)}/manual/${encodeURIComponent(workerId)}`, {
        method: "POST",
      });
      const data = await readBulkApiResponse(res, "Failed to open manual session");
      if (!res.ok) throw new Error(data.error || "Failed to open manual session");
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDoneRefresh = () => {
    resetState();
    onSuccess?.();
  };

  return (
    <Modal
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      size="full"
      className="max-w-[min(96vw,1320px)]"
    >
      <div className="flex flex-col gap-4">
        {!activeJob && (
          <>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                {introText || `Bulk login runs browser workers in the background. Use one account per line in ${accountFormat} format. Accounts that hit CAPTCHA, 2FA, or recovery prompts move to manual assist.`}
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Bulk Accounts <span className="text-red-500">*</span>
              </label>
              <textarea
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder={accountFormat === "email|password" ? "user1@example.com|password1\nuser2@example.com|password2" : "gmail1@example.com|password1\ngmail2@example.com|password2"}
                className="min-h-[180px] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-text-muted">
                One account per line in the format {accountFormat}.
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Concurrent Workers</label>
              <Input
                type="number"
                min="1"
                max={maxConcurrency}
                value={concurrency}
                onChange={(event) => setConcurrency(event.target.value)}
                placeholder={String(defaultConcurrency)}
              />
              <div className="mt-1 flex flex-col gap-1 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Recommended {recommendedConcurrency?.value || defaultConcurrency}. Allowed range: 1 to {maxConcurrency} worker{maxConcurrency === 1 ? "" : "s"}. {recommendedConcurrency?.details || ""}
                </p>
                {recommendedConcurrency?.value && String(recommendedConcurrency.value) !== concurrency && (
                  <button
                    type="button"
                    onClick={() => setConcurrency(String(recommendedConcurrency.value))}
                    className="text-left font-medium text-primary hover:underline sm:text-right"
                  >
                    Use recommended
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Camoufox automation</span>
                <span className="rounded-full bg-sidebar px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">Default</span>
              </div>
              <p className="mt-1 text-xs text-text-muted">Runs isolated browser workers in the background.</p>
            </div>
            {enableProxyPool && (
              <div className="rounded-lg border border-border bg-background p-3">
                <label htmlFor={`${provider}-bulk-proxy-pool`} className="mb-1 block text-sm font-medium">
                  Worker proxy pool
                  {!requireProxyPool && <span className="ml-1 text-xs font-normal text-text-muted">(optional)</span>}
                </label>
                <select
                  id={`${provider}-bulk-proxy-pool`}
                  value={proxyPoolId}
                  onChange={(event) => setProxyPoolId(event.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {/*
                    Auto pool: server aggregates every active browser-compatible
                    pool and hands one unique proxy to each worker.
                  */}
                  <option value={AUTO_PROXY_POOL_ID}>
                    Auto pool — combine every active pool
                  </option>
                  {/*
                    Direct: workers launch without any outbound proxy. Only
                    offered when the flow does not physically require one.
                  */}
                  {!requireProxyPool && (
                    <option value={NONE_PROXY_POOL_ID}>
                      None (direct) — no proxy, workers use host IP
                    </option>
                  )}
                  {proxyPools.length > 0 && (
                    <optgroup label="Specific pool">
                      {proxyPools.map((pool) => (
                        <option key={pool.id} value={pool.id}>
                          {pool.name || pool.id} ({pool.type || "http"})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {proxyPools.length === 0 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    No active browser-compatible proxy pool found. {requireProxyPool
                      ? "This flow requires a proxy pool — add one under Proxy Pools first."
                      : "You can still start in direct mode; add pools later for better isolation."}
                  </p>
                )}
                <p className="mt-1 text-xs text-text-muted">
                  {proxyPoolId === AUTO_PROXY_POOL_ID
                    ? "Auto pool picks one unique proxy per worker from every active pool. Falls back to the next candidate if a pool proxy fails to open a browser."
                    : proxyPoolId === NONE_PROXY_POOL_ID
                      ? "Workers share the host outbound IP. Fine for a handful of accounts; scale-out benefits from a proxy pool."
                      : "Each worker uses one unique proxy from the selected pool. The pool must contain at least one unique proxy per account."}
                </p>
              </div>
            )}
          </>
        )}

        {activeJob && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="font-semibold">{serviceName} Bulk Login Job</h3>
                <p className="text-xs text-text-muted">
                  Job ID: <span className="font-mono">{activeJob.jobId}</span>
                </p>
                <p className="text-xs text-text-muted">
                  Status: <span className="font-medium">{activeJob.status}</span> | Workers: {activeJob.concurrency}
                </p>
              </div>
              <div className="flex gap-2">
                {runningJob && (
                  <Button size="sm" variant="secondary" onClick={handleCancelJob}>
                    Cancel Job
                  </Button>
                )}
                {finishedJob && (
                  <Button size="sm" onClick={handleDoneRefresh}>
                    Done & Refresh
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {Object.entries(activeJob.summary || {}).map(([label, value]) => (
                <div key={label} className="rounded-lg bg-sidebar px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">{formatStepLabel(label)}</p>
                  <p className="text-lg font-semibold">{value}</p>
                </div>
              ))}
            </div>

            {activeJob.error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                {activeJob.error}
              </div>
            )}

            {activeJob.summary?.needs_manual > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                Some accounts need manual assist. Open the worker session, finish the Google or {serviceName} prompts, and the job will keep polling.
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(300px,3fr)]">
              <div className="space-y-4">
                <div className="overflow-hidden rounded-xl border border-border bg-sidebar">
                  <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold">Live Browser Preview</p>
                      <p className="text-xs text-text-muted">
                        {activeJob.preview?.email || "Waiting for worker"}
                        {activeJob.preview?.workerId ? ` | Worker ${activeJob.preview.workerId}` : ""}
                      </p>
                    </div>
                    <div className="text-right text-xs text-text-muted">
                      <p>{formatStepLabel(activeJob.preview?.step)}</p>
                      <p>Updated {formatClock(activeJob.preview?.updatedAt)}</p>
                    </div>
                  </div>
                  <div className="relative bg-black/90">
                    {activeJob.preview?.imageData ? (
                      <Image
                        src={activeJob.preview.imageData}
                        alt={`Live worker preview for ${activeJob.preview.email || serviceName}`}
                        width={1440}
                        height={900}
                        unoptimized
                        className="h-[340px] w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-[340px] flex-col items-center justify-center gap-3 px-6 text-center text-slate-200">
                        <span className="material-symbols-outlined text-5xl text-primary/80">browser_updated</span>
                        <div>
                          <p className="text-base font-medium">Preview will appear when a worker opens Google or {serviceName}</p>
                          <p className="mt-1 text-sm text-slate-400">The job keeps running even when a screenshot is not available yet.</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {groupedAccounts.map((group) => (
                  <div key={group.status} className="rounded-xl border border-border p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AccountStatusBadge status={group.status} />
                        <p className="text-sm font-semibold capitalize">{formatStepLabel(group.status)}</p>
                      </div>
                      <p className="text-xs text-text-muted">{group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}</p>
                    </div>

                    <div className="grid gap-3 xl:grid-cols-2">
                      {group.accounts.map((account) => (
                        <div key={`${account.email}-${account.line}`} className="rounded-xl border border-border bg-background/80 p-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{account.email}</p>
                              <p className="text-[11px] text-text-muted">
                                Line {account.line}{account.workerId ? ` | Worker ${account.workerId}` : ""} | {formatClock(account.updatedAt)}
                              </p>
                            </div>
                            <AccountStatusBadge status={account.status} />
                          </div>

                          <div className="mt-3 rounded-lg border border-border/70 bg-sidebar/70 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-text-muted">Current Step</p>
                            <p className="mt-1 text-sm font-medium capitalize">{formatStepLabel(account.currentStep)}</p>
                          </div>

                          {account.error && (
                            <p className="mt-3 text-xs text-red-500">{account.error}</p>
                          )}

                          {account.manualSessionAvailable && account.workerId ? (
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                              <Button
                                size="sm"
                                variant={account.manualSessionOpened ? "secondary" : "primary"}
                                onClick={() => handleOpenManualSession(account.workerId)}
                              >
                                {account.manualSessionOpened ? "Re-open Manual Session" : "Open Manual Session"}
                              </Button>
                              <p className="text-[11px] text-text-muted">
                                Use this only for CAPTCHA, 2FA, or recovery prompts.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-border bg-sidebar/70">
                <div className="border-b border-border px-4 py-3">
                  <p className="text-sm font-semibold">Live Activity Log</p>
                  <p className="text-xs text-text-muted">Worker steps update in near real time.</p>
                </div>
                <div className="max-h-[640px] space-y-3 overflow-y-auto p-4">
                  {activityItems.length === 0 && (
                    <div className="rounded-lg bg-background/70 px-3 py-4 text-sm text-text-muted">
                      Waiting for the first worker event...
                    </div>
                  )}
                  {activityItems.map((entry) => (
                    <div key={entry.id} className="rounded-lg border border-border/70 bg-background/80 px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{entry.email}</p>
                          <p className="text-[11px] text-text-muted">
                            {entry.workerId ? `Worker ${entry.workerId}` : "Waiting"} | {formatStepLabel(entry.step)}
                          </p>
                        </div>
                        <span className="shrink-0 text-[11px] text-text-muted">{formatClock(entry.at)}</span>
                      </div>
                      <p className="mt-2 text-xs text-text-muted">{entry.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {jobRestoreNotice && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
            <p className="text-sm text-amber-700 dark:text-amber-300">{jobRestoreNotice}</p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          {!activeJob && (
            <Button
              onClick={handleStartBulk}
              fullWidth
              disabled={
                importing
                || !bulkText.trim()
                // Only gate on proxy selection when the flow actually needs
                // one. "" (None/direct) is valid for optional flows and Auto
                // pool is always a valid non-empty sentinel.
                || (enableProxyPool && requireProxyPool && !proxyPoolId)
              }
            >
              {importing ? "Starting..." : "Start Bulk Login"}
            </Button>
          )}
          {activeJob && !finishedJob && (
            <Button onClick={handleCancelJob} fullWidth variant="secondary" disabled={!runningJob}>
              {runningJob ? "Cancel Running Job" : "Job Stopped"}
            </Button>
          )}
          {finishedJob && (
            <Button onClick={handleDoneRefresh} fullWidth>
              Done & Refresh Connections
            </Button>
          )}
          <Button onClick={activeJob ? resetState : onClose} variant="ghost" fullWidth>
            {activeJob ? "Clear" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BulkAccountAutomationModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
  provider: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  serviceName: PropTypes.string.isRequired,
  defaultConcurrency: PropTypes.number,
  maxConcurrency: PropTypes.number,
  accountFormat: PropTypes.string,
  introText: PropTypes.string,
  enableProxyPool: PropTypes.bool,
  requireProxyPool: PropTypes.bool,
};
