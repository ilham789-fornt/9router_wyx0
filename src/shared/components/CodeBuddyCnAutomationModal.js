"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Input from "./Input";
import Modal from "./Modal";
import { AUTOMATION_BROWSER_OPTIONS, DEFAULT_AUTOMATION_BROWSER, normalizeAutomationBrowser } from "@/shared/constants/automationBrowsers";

const ACTIVE_JOB_STORAGE_KEY = "codebuddy-cn-automation-active-job";
const TERMINAL_JOB_STATUSES = new Set(["completed", "cancelled", "failed"]);
const DEFAULT_ROUTE = {
  country: "hongkong",
  operator: "virtual54",
  product: "codebuddy",
};

function isTerminalJob(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function statusVariant(status) {
  if (status === "success" || status === "completed") return "success";
  if (status === "failed" || status === "failed_timeout") return "error";
  if (status === "cancelled" || status === "needs_manual") return "warning";
  return "default";
}

async function readResponse(response, fallback) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error || fallback);
  return data;
}

export default function CodeBuddyCnAutomationModal({
  isOpen,
  onClose,
  onSuccess,
  disabled = false,
  mode = "5sim",
}) {
  const [fiveSimApiKey, setFiveSimApiKey] = useState("");
  const [count, setCount] = useState("1");
  const [concurrent, setConcurrent] = useState("1");
  const [country, setCountry] = useState(DEFAULT_ROUTE.country);
  const [operator, setOperator] = useState(DEFAULT_ROUTE.operator);
  const [product, setProduct] = useState(DEFAULT_ROUTE.product);
  const [job, setJob] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState("");
  const [restoreNotice, setRestoreNotice] = useState("");
  const [starting, setStarting] = useState(false);
  const [checkingQuote, setCheckingQuote] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const notifiedJobRef = useRef(null);
  // Browser runtime choice (Camoufox default, Chromium alt) + proxy pool for
  // login wrapping. The 5sim flow sends the chosen browser to /cbcn/start;
  // the wrap-login flow also sends proxyPoolId to /cbcn/wrap-login.
  const [browser, setBrowser] = useState(DEFAULT_AUTOMATION_BROWSER);
  const [proxyPoolId, setProxyPoolId] = useState("");
  const [proxyPools, setProxyPools] = useState([]);
  const storageKey = mode === "wrap-login"
    ? "codebuddy-cn-proxy-login-active-job"
    : ACTIVE_JOB_STORAGE_KEY;

  const rememberJob = useCallback((nextJob) => {
    setJob(nextJob || null);
    if (typeof window === "undefined") return;
    if (nextJob?.jobId && !isTerminalJob(nextJob.status)) {
      window.localStorage.setItem(storageKey, nextJob.jobId);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const fetchJob = useCallback(async (jobId) => {
    const response = await fetch(`/api/tools/automation/cbcn/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    return await readResponse(response, "Failed to load the CodeBuddy CN automation job");
  }, []);

  const fetchLatestJob = useCallback(async () => {
    const response = await fetch("/api/tools/automation/cbcn/logs?scope=recoverable", {
      cache: "no-store",
    });
    if (response.status === 404) return null;
    return await readResponse(response, "Failed to restore the latest CodeBuddy CN job");
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;

    const restore = async () => {
      setError("");
      const storedJobId = typeof window !== "undefined"
        ? window.localStorage.getItem(storageKey)
        : null;
      try {
        const payload = storedJobId
          ? await fetchJob(storedJobId).catch(() => fetchLatestJob())
          : await fetchLatestJob();
        if (cancelled || !payload?.job) return;
        rememberJob(payload.job);
        setRestoreNotice("Restored the latest CodeBuddy CN automation job.");
      } catch (restoreError) {
        if (!cancelled) setError(restoreError.message);
      }
    };

    void restore();
    return () => { cancelled = true; };
  }, [fetchJob, fetchLatestJob, isOpen, rememberJob, storageKey]);

  // Load active browser-compatible proxy pools for login wrapping.
  useEffect(() => {
    if (!isOpen || mode !== "wrap-login") return undefined;
    let cancelled = false;
    const loadPools = async () => {
      try {
        const res = await fetch("/api/proxy-pools?view=options&isActive=true", { cache: "no-store" });
        const data = await res.json();
        const pools = (Array.isArray(data) ? data : data?.proxyPools || data?.pools || [])
          .filter((pool) => pool && pool.isActive !== false)
          .filter((pool) => !["vercel", "cloudflare", "deno"].includes(pool.type));
        if (!cancelled) {
          setProxyPools(pools);
          if (!proxyPoolId && pools[0]?.id) setProxyPoolId(pools[0].id);
        }
      } catch {
        if (!cancelled) setProxyPools([]);
      }
    };
    void loadPools();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- proxyPoolId is read only for the initial auto-select; including it would refetch pools on every selection.
  }, [isOpen, mode]);

  useEffect(() => {
    if (!isOpen || !job?.jobId || isTerminalJob(job.status)) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const payload = await fetchJob(job.jobId);
        if (!cancelled && payload?.job) {
          rememberJob(payload.job);
          setError("");
        }
      } catch (pollError) {
        if (!cancelled) setError(pollError.message);
      }
    };

    void poll();
    const timer = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchJob, isOpen, job?.jobId, job?.status, rememberJob]);

  useEffect(() => {
    if (!job?.jobId || !isTerminalJob(job.status) || notifiedJobRef.current === job.jobId) return;
    notifiedJobRef.current = job.jobId;
    if (job.summary?.success > 0) onSuccess?.();
  }, [job, onSuccess]);

  const checkFiveSimQuote = async () => {
    const parsedCount = Number.parseInt(count, 10);
    if (!fiveSimApiKey.trim()) {
      setError("Enter your 5sim API key.");
      return null;
    }
    if (!Number.isFinite(parsedCount) || parsedCount < 1) {
      setError("Account count must be at least 1.");
      return null;
    }

    setCheckingQuote(true);
    setError("");
    try {
      const response = await fetch("/api/tools/automation/cbcn/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: parsedCount,
          fiveSimApiKey: fiveSimApiKey.trim(),
          country: country.trim() || DEFAULT_ROUTE.country,
          operator: operator.trim() || DEFAULT_ROUTE.operator,
          product: product.trim() || DEFAULT_ROUTE.product,
        }),
      });
      const payload = await readResponse(response, "Failed to check 5sim capacity");
      setQuote(payload.quote || null);
      return payload.quote || null;
    } catch (quoteError) {
      setQuote(null);
      setError(quoteError.message);
      return null;
    } finally {
      setCheckingQuote(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setError("");
    setRestoreNotice("");
    try {
      let response;
      if (mode === "wrap-login") {
        if (!proxyPoolId) {
          setError("Select an active proxy pool to wrap the login.");
          setStarting(false);
          return;
        }
        response = await fetch("/api/tools/automation/cbcn/wrap-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxyPoolId, browser }),
        });
      } else {
        const parsedCount = Number.parseInt(count, 10);
        const parsedConcurrent = Number.parseInt(concurrent, 10);
        if (!fiveSimApiKey.trim()) {
          setError("Enter your 5sim API key.");
          setStarting(false);
          return;
        }
        if (!Number.isFinite(parsedCount) || parsedCount < 1) {
          setError("Account count must be at least 1.");
          setStarting(false);
          return;
        }
        response = await fetch("/api/tools/automation/cbcn/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            count: parsedCount,
            concurrent: Number.isFinite(parsedConcurrent) ? parsedConcurrent : 1,
            fiveSimApiKey: fiveSimApiKey.trim(),
            fiveSimCountry: country.trim() || DEFAULT_ROUTE.country,
            fiveSimOperator: operator.trim() || DEFAULT_ROUTE.operator,
            fiveSimProduct: product.trim() || DEFAULT_ROUTE.product,
            browser,
          }),
        });
      }
      const payload = await readResponse(response, mode === "wrap-login" ? "Failed to start CodeBuddy CN login wrapping" : "Failed to start CodeBuddy CN bulk registration");
      notifiedJobRef.current = null;
      rememberJob(payload.job);
      setQuote(null);
      if (mode !== "wrap-login") setFiveSimApiKey("");
    } catch (startError) {
      setError(startError.message);
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job?.jobId) return;
    setCancelling(true);
    setError("");
    try {
      const response = await fetch("/api/tools/automation/cbcn/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId }),
      });
      const payload = await readResponse(response, "Failed to cancel CodeBuddy CN automation");
      rememberJob(payload.job);
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setCancelling(false);
    }
  };

  const handleClose = () => {
    setFiveSimApiKey("");
    setQuote(null);
    setError("");
    onClose?.();
  };

  const resetJob = () => {
    notifiedJobRef.current = null;
    setRestoreNotice("");
    setQuote(null);
    rememberJob(null);
  };

  const active = Boolean(job?.jobId && !isTerminalJob(job.status));
  const summary = job?.summary || {};

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={mode === "wrap-login" ? "CodeBuddy CN OAuth via Proxy" : "CodeBuddy CN 5sim Bulk Registration"}
      size="full"
      closeOnOverlay={!starting && !cancelling}
    >
      <div className="flex min-w-0 flex-col gap-5">
        {!active && mode === "wrap-login" && (
          <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1 block text-xs font-semibold text-text-muted">Browser runtime</label>
              <div className="flex flex-wrap gap-2">
                {AUTOMATION_BROWSER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setBrowser(opt.id)}
                    disabled={disabled || starting}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      normalizeAutomationBrowser(browser) === opt.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background text-text-main hover:border-primary/30"
                    }`}
                  >
                    {opt.label}{opt.badge ? ` (${opt.badge})` : ""}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-text-muted">Camoufox matches locale/timezone to the proxy exit IP. Chromium uses an installed Chrome, Edge, or Chromium browser on this host.</p>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1 block text-xs font-semibold text-text-muted">Proxy pool</label>
              {proxyPools.length === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">No active browser-compatible proxy pools found. Create one under Proxy Pools.</p>
              ) : (
                <select
                  value={proxyPoolId}
                  onChange={(e) => setProxyPoolId(e.target.value)}
                  disabled={disabled || starting}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {proxyPools.map((pool) => (
                    <option key={pool.id} value={pool.id}>{pool.name || pool.id} ({pool.type || "http"})</option>
                  ))}
                </select>
              )}
              <p className="mt-1 text-[11px] text-text-muted">The OAuth authorization page uses this proxy for browser egress. Access and refresh tokens are obtained from the official OAuth token endpoint; no API key is created.</p>
            </div>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button onClick={handleStart} loading={starting} disabled={disabled || !proxyPoolId} icon="vpn_lock">
                Start OAuth via Proxy
              </Button>
            </div>
          </div>
        )}
        {!active && mode !== "wrap-login" && (
          <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1 block text-xs font-semibold text-text-muted">Browser runtime</label>
              <div className="flex flex-wrap gap-2">
                {AUTOMATION_BROWSER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setBrowser(opt.id)}
                    disabled={disabled || starting}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      normalizeAutomationBrowser(browser) === opt.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background text-text-main hover:border-primary/30"
                    }`}
                  >
                    {opt.label}{opt.badge ? ` (${opt.badge})` : ""}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label="5sim API Key"
              type="password"
              value={fiveSimApiKey}
              onChange={(event) => setFiveSimApiKey(event.target.value)}
              placeholder="Enter 5sim API key"
              disabled={disabled || starting}
              required
            />
            <Input
              label="Accounts"
              type="number"
              min="1"
              value={count}
              onChange={(event) => setCount(event.target.value)}
              disabled={disabled || starting}
            />
            <Input
              label="Workers"
              type="number"
              min="1"
              max="8"
              value={concurrent}
              onChange={(event) => setConcurrent(event.target.value)}
              disabled={disabled || starting}
            />
            <Input label="5sim Country" value={country} onChange={(event) => setCountry(event.target.value)} disabled={disabled || starting} />
            <Input label="5sim Operator" value={operator} onChange={(event) => setOperator(event.target.value)} disabled={disabled || starting} />
            <Input label="5sim Product" value={product} onChange={(event) => setProduct(event.target.value)} disabled={disabled || starting} />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button onClick={handleStart} loading={starting} disabled={disabled || checkingQuote || !fiveSimApiKey.trim()} icon="play_arrow">
                Start Bulk Registration
              </Button>
              <Button variant="secondary" onClick={checkFiveSimQuote} loading={checkingQuote} disabled={disabled || starting || !fiveSimApiKey.trim()} icon="calculate">
                Check 5sim Capacity
              </Button>
              {job?.jobId && isTerminalJob(job.status) && (
                <Button variant="secondary" onClick={resetJob} icon="refresh">
                  Clear Previous Result
                </Button>
              )}
            </div>
            {quote && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-text-main sm:col-span-2 lg:col-span-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>Balance: <strong>{quote.balance}</strong></span>
                  <span>Unit: <strong>{quote.unitCost ?? "—"}</strong></span>
                  <span>Available: <strong>{quote.availableCount || 0}</strong></span>
                  <span>Can buy: <strong>{quote.capacity || 0}</strong></span>
                  <span>Route: <strong>{quote.proxyRoute || "direct"}</strong></span>
                </div>
                {!quote.canAffordRequested && (
                  <p className="mt-2 text-amber-600 dark:text-amber-400">
                    Requested {quote.requestedCount}; short by {quote.shortage}. Add 5sim balance or lower the account count.
                  </p>
                )}
                {quote.noStockMessage && <p className="mt-2 text-amber-600 dark:text-amber-400">{quote.noStockMessage}</p>}
              </div>
            )}
          </div>
        )}

        {restoreNotice && (
          <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">{restoreNotice}</p>
        )}
        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {job?.jobId && (
          <>
            <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-text-main">{mode === "wrap-login" ? "Proxy OAuth job" : "Bulk job"}</h3>
                  <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                </div>
                <p className="mt-1 break-all text-xs text-text-muted">{job.jobId}</p>
              </div>
              {active && (
                <Button variant="danger" icon="stop" loading={cancelling} onClick={handleCancel}>
                  Cancel Job
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {[
                ["Total", summary.total],
                ["Queued", summary.queued],
                ["Running", summary.running],
                ["Success", summary.success],
                ["Failed", summary.failed],
                ["Manual", summary.needs_manual],
                ["Cancelled", summary.cancelled],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-background/40 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
                  <p className="text-lg font-semibold text-text-main">{value || 0}</p>
                </div>
              ))}
            </div>

            {job.preview?.imageData && (
              <div className="overflow-hidden rounded-xl border border-border bg-black">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-white/70">
                  <span>Live Browser Preview</span>
                  <span>{job.preview.label || "CodeBuddy CN"} · {job.preview.step || job.preview.status}</span>
                </div>
                {/* Data-URL screenshots are ephemeral job previews; Next Image cannot optimize them. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={job.preview.imageData} alt="CodeBuddy CN browser preview" className="max-h-[420px] w-full object-contain" />
              </div>
            )}

            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <section className="min-w-0 rounded-xl border border-border p-4">
                <h3 className="mb-3 font-semibold text-text-main">Accounts</h3>
                <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                  {(job.accounts || []).map((account) => (
                    <div key={`${account.line}-${account.label}`} className="rounded-lg border border-border bg-background/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-main">{account.label}</p>
                          <p className="text-xs text-text-muted">Line {account.line} · Worker {account.workerId || "—"}</p>
                        </div>
                        <Badge variant={statusVariant(account.status)} size="sm">{account.status}</Badge>
                      </div>
                      <p className="mt-2 text-xs text-text-muted">{account.currentStep || "queued"}</p>
                      {account.error && <p className="mt-1 text-xs text-red-500">{account.error}</p>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="min-w-0 rounded-xl border border-border p-4">
                <h3 className="mb-3 font-semibold text-text-main">Live Activity</h3>
                <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                  {(job.activity || []).slice().reverse().map((entry) => (
                    <div key={entry.id} className="rounded-lg border border-border bg-background/40 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium text-text-main">{entry.label}</p>
                        <span className="shrink-0 text-[11px] text-text-muted">{entry.at ? new Date(entry.at).toLocaleTimeString() : ""}</span>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">Worker {entry.workerId || "—"} · {entry.step}</p>
                      <p className="mt-1 break-words text-xs text-text-main">{entry.message}</p>
                    </div>
                  ))}
                  {(job.activity || []).length === 0 && <p className="text-sm text-text-muted">No activity yet.</p>}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
