"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Modal from "./Modal";
import { AUTOMATION_BROWSER_OPTIONS, DEFAULT_AUTOMATION_BROWSER, normalizeAutomationBrowser } from "@/shared/constants/automationBrowsers";

const STORAGE_KEY = "codebuddy-proxy-login-active-job";
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);
const AUTO_PROXY_POOL_ID = "__auto__";

async function readResponse(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || fallback);
  return data;
}

function variant(status) {
  if (status === "completed" || status === "success") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "warning";
  return "default";
}

export default function CodeBuddyProxyOAuthModal({ isOpen, onClose, onSuccess, disabled = false }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState("");
  const [browser, setBrowser] = useState(DEFAULT_AUTOMATION_BROWSER);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const notifiedRef = useRef(null);
  const active = Boolean(job?.jobId && !TERMINAL_STATUSES.has(job.status));

  const rememberJob = useCallback((nextJob) => {
    setJob(nextJob || null);
    if (typeof window === "undefined") return;
    if (nextJob?.jobId && !TERMINAL_STATUSES.has(nextJob.status)) {
      window.localStorage.setItem(STORAGE_KEY, nextJob.jobId);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const fetchJob = useCallback(async (jobId) => {
    const response = await fetch(`/api/oauth/codebuddy/bulk-import/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    return await readResponse(response, "Failed to load the CodeBuddy OAuth job");
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?view=options&isActive=true", { cache: "no-store" }).then((response) => response.json()),
      (async () => {
        const storedId = window.localStorage.getItem(STORAGE_KEY);
        if (storedId) return await fetchJob(storedId).catch(() => null);
        const response = await fetch("/api/oauth/codebuddy/bulk-import/latest?scope=recoverable", { cache: "no-store" });
        return response.status === 404 ? null : await readResponse(response, "Failed to restore the CodeBuddy OAuth job");
      })(),
    ]).then(([poolData, jobData]) => {
      if (cancelled) return;
      const pools = (Array.isArray(poolData) ? poolData : poolData?.proxyPools || poolData?.pools || [])
        .filter((pool) => pool?.isActive !== false && !["vercel", "cloudflare", "deno"].includes(pool?.type));
      setProxyPools(pools);
      setProxyPoolId((current) => current || AUTO_PROXY_POOL_ID);
      if (jobData?.job) rememberJob(jobData.job);
    }).catch((loadError) => {
      if (!cancelled) setError(loadError.message);
    });
    return () => { cancelled = true; };
  }, [fetchJob, isOpen, rememberJob]);

  useEffect(() => {
    if (!isOpen || !active) return undefined;
    const poll = async () => {
      try {
        const payload = await fetchJob(job.jobId);
        rememberJob(payload.job);
        setError("");
      } catch (pollError) {
        setError(pollError.message);
      }
    };
    const timer = window.setInterval(poll, 2_000);
    void poll();
    return () => window.clearInterval(timer);
  }, [active, fetchJob, isOpen, job?.jobId, rememberJob]);

  useEffect(() => {
    if (!job?.jobId || !TERMINAL_STATUSES.has(job.status) || notifiedRef.current === job.jobId) return;
    notifiedRef.current = job.jobId;
    if (job.summary?.success > 0) onSuccess?.();
    if (job.error || job.accounts?.[0]?.error) {
      setError(job.error || job.accounts[0].error);
    }
  }, [job, onSuccess]);

  const start = async () => {
    if (!proxyPoolId) return;
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/oauth/codebuddy/wrap-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyPoolId, browser }),
      });
      const payload = await readResponse(response, "Failed to start CodeBuddy OAuth via proxy");
      notifiedRef.current = null;
      rememberJob(payload.job);
    } catch (startError) {
      setError(startError.message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    setError("");
    try {
      const response = await fetch(`/api/oauth/codebuddy/bulk-import/${encodeURIComponent(job.jobId)}/cancel`, { method: "POST" });
      const payload = await readResponse(response, "Failed to cancel CodeBuddy OAuth job");
      rememberJob(payload.job);
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="CodeBuddy OAuth via Proxy" size="full" closeOnOverlay={!starting && !cancelling}>
      <div className="flex flex-col gap-5">
        {!active && (
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <div className="mb-3">
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
            <label htmlFor="codebuddy-proxy-pool" className="mb-1 block text-xs font-semibold text-text-muted">Proxy pool</label>
            {proxyPools.length ? (
              <select id="codebuddy-proxy-pool" value={proxyPoolId} onChange={(event) => setProxyPoolId(event.target.value)} disabled={disabled || starting} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary">
                <option value={AUTO_PROXY_POOL_ID}>Auto pool — test all active pools</option>
                {proxyPools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name || pool.id} ({pool.type || "http"})</option>)}
              </select>
            ) : <p className="text-xs text-amber-600 dark:text-amber-400">No active browser-compatible proxy pools found.</p>}
            <p className="mt-2 text-xs text-text-muted">Auto pool tests active proxies in order and retries browser launch with the next candidate until the login browser opens. OAuth tokens still come from the official endpoint.</p>
            <Button onClick={start} loading={starting} disabled={disabled || !proxyPoolId} icon="vpn_lock" className="mt-3">Start OAuth via Proxy</Button>
          </div>
        )}
        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {job?.jobId && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <div><div className="flex items-center gap-2"><h3 className="font-semibold text-text-main">Proxy OAuth job</h3><Badge variant={variant(job.status)}>{job.status}</Badge></div><p className="mt-1 break-all text-xs text-text-muted">{job.jobId}</p></div>
              {active && <Button variant="danger" icon="stop" loading={cancelling} onClick={cancel}>Cancel Job</Button>}
            </div>
            {job.preview?.imageData && <div className="overflow-hidden rounded-xl border border-border bg-black"><div className="border-b border-white/10 px-3 py-2 text-xs text-white/70">Live Browser Preview</div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={job.preview.imageData} alt="CodeBuddy Global OAuth browser preview" className="max-h-[420px] w-full object-contain" /></div>}
            <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold text-text-main">OAuth Debug Activity</h3><span className="text-[11px] text-text-muted">Secrets are redacted</span></div><div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">{(job.activity || []).slice().reverse().map((entry) => <div key={entry.id} className="rounded-lg border border-border bg-background/40 p-3"><div className="flex items-start justify-between gap-3"><p className="text-xs font-medium text-text-main">{entry.step}</p><span className="shrink-0 text-[11px] text-text-muted">{entry.at ? new Date(entry.at).toLocaleTimeString() : ""}</span></div><p className="mt-1 text-xs text-text-muted">{entry.message}</p></div>)}</div></div>
          </>
        )}
      </div>
    </Modal>
  );
}
