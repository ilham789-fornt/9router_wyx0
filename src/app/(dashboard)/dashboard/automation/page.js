"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, BulkAccountAutomationModal, Card, CardSkeleton, CodeBuddyCnAutomationModal, CodeBuddyProxyOAuthModal, KiroOAuthWrapper, OAuthModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { isProviderDisabledFromConnections } from "@/shared/utils/providerConnectionStats";

function AutomationProviderIcon({ providerId, providerMeta, size = 32 }) {
  const meta = providerMeta || AI_PROVIDERS[providerId] || { id: providerId };
  const color = meta.color || "#888888";
  const iconSize = Math.max(22, size - 2);

  return (
    <div
      className="shrink-0 rounded-lg flex items-center justify-center"
      style={{
        width: size,
        height: size,
        backgroundColor: color.length > 7 ? color : `${color}15`,
      }}
    >
      <ProviderIcon
        src={meta.image || `/providers/${providerId}.png`}
        alt={meta.name || providerId}
        size={iconSize}
        className="object-contain rounded-lg max-w-[32px] max-h-[32px]"
        fallbackText={meta.textIcon || providerId.slice(0, 2).toUpperCase()}
        fallbackColor={color}
      />
    </div>
  );
}

function getConnectionLabel(count) {
  return `${count} connection${count === 1 ? "" : "s"}`;
}

function getAutomationCardClasses(disabled = false) {
  return `flex min-h-[112px] min-w-0 flex-col gap-2 rounded-lg border px-4 py-3 text-left transition-colors ${
    disabled
      ? "cursor-not-allowed border-border bg-surface opacity-50"
      : "border-border bg-surface hover:border-primary/40 hover:bg-primary/5"
  }`;
}

function getProviderDisabledMessage(providerInfo, providerId) {
  if (providerInfo?.systemDisabled) {
    return `${providerInfo?.name || providerId} is permanently disabled by the system because the upstream rejects this integration with code 11140: request illegal.`;
  }
  return `${providerInfo?.name || providerId} is disabled. Re-enable it from the Providers tab to use this feature.`;
}

function KiroAutomationPanel({ providerInfo, onRefresh, disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [bulkJob, setBulkJob] = useState(null);
  const [initialFlow, setInitialFlow] = useState(null);
  const openFlow = (flow) => {
    if (disabled) return;
    setInitialFlow({ ...flow, key: Date.now() });
    setIsOpen(true);
  };

  const options = [
    {
      id: "bulk-account",
      title: "Auto Login Bulk",
      icon: "group_add",
      description: "Run bulk gmail|password automation with worker progress and manual assist.",
      action: () => openFlow({ method: "import", importMode: "bulk-account" }),
    },
    {
      id: "bulk-token",
      title: "Bulk Token",
      icon: "playlist_add",
      description: "Import many Kiro refresh tokens, one token per line.",
      action: () => openFlow({ method: "import", importMode: "bulk-token" }),
    },
    {
      id: "single-token",
      title: "Single Token",
      icon: "vpn_key",
      description: "Auto-detect or paste one Kiro refresh token.",
      action: () => openFlow({ method: "import", importMode: "single-token" }),
    },
    {
      id: "builder-id",
      title: "AWS Builder ID",
      icon: "shield",
      description: "Open the standard AWS Builder ID device login.",
      action: () => openFlow({ method: "builder-id" }),
    },
    {
      id: "idc",
      title: "AWS IDC",
      icon: "business",
      description: "Enter an IAM Identity Center start URL and region.",
      action: () => openFlow({ method: "idc" }),
    },
    {
      id: "google",
      title: "Google Login",
      icon: "account_circle",
      description: "Open Kiro social Google login with callback capture.",
      action: () => openFlow({ method: "social", provider: "google" }),
    },
  ];

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={option.action}
            disabled={disabled}
            className={getAutomationCardClasses(disabled)}
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
              <span className="material-symbols-outlined text-[20px] text-primary">{option.icon}</span>
              {option.title}
            </span>
            <span className="text-xs leading-relaxed text-text-muted">{option.description}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {bulkJob?.jobId && (
          <Badge variant="default">
            Bulk job: {bulkJob.status}
          </Badge>
        )}
        {bulkJob?.jobId && (
          <Button
            size="sm"
            variant="secondary"
            icon="monitoring"
            disabled={disabled}
            onClick={() => openFlow({ method: "import", importMode: "bulk-account" })}
          >
            Resume Bulk Progress
          </Button>
        )}
      </div>
      <KiroOAuthWrapper
        isOpen={isOpen && !disabled}
        providerInfo={providerInfo}
        onSuccess={onRefresh}
        onRefresh={onRefresh}
        initialBulkJobId={bulkJob?.jobId || null}
        initialFlow={initialFlow}
        onBulkJobChange={setBulkJob}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}

function CodeBuddyBulkTokenModal({ isOpen, onClose, onSuccess, disabled = false }) {
  const [tokens, setTokens] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleImport = async () => {
    if (disabled || !tokens.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/oauth/codebuddy/bulk-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens }),
      });
      const data = await res.json();
      setResult(data);
      if (data.success) onSuccess?.();
    } catch (error) {
      setResult({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const successMsg = result?.success
    ? `Imported ${result.imported}/${result.total} tokens.${result.failed ? ` ${result.failed} failed.` : ""}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-semibold text-text-main">CodeBuddy Bulk Token Import</h3>
        <p className="mb-3 text-xs text-text-muted">Paste access tokens, one per line. Each token will be validated and imported as a connection.</p>
        <textarea
          className="mb-3 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
          rows={8}
          placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          disabled={loading || disabled}
        />
        {result && (
          <div className={"mb-3 rounded-lg p-3 text-xs " + (result.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400")}>
            {successMsg || result.error || "Import failed"}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-border/50">Close</button>
          <button
            type="button"
            onClick={handleImport}
            disabled={loading || disabled || !tokens.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Importing..." : "Import Tokens"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeBuddyAutomationPanel({ providerInfo, onRefresh, disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isBulkGithubOpen, setIsBulkGithubOpen] = useState(false);
  const [isBulkGithubRegisterOpen, setIsBulkGithubRegisterOpen] = useState(false);
  const [isBulkTokenOpen, setIsBulkTokenOpen] = useState(false);
  const [isWrapOpen, setIsWrapOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={() => setIsWrapOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">vpn_lock</span>
            OAuth via Proxy
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Open the official CodeBuddy Global OAuth login through an active proxy pool and save access/refresh tokens.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsBulkOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">group_add</span>
            Auto Login Bulk
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Run bulk GSuite gmail|password login with worker progress and manual assist.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsBulkGithubOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">code</span>
            Auto Login Bulk (GitHub)
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Sign up / log in CodeBuddy accounts via GitHub SSO in isolated Camoufox workers. Optional proxy pool, one github_username|password per line.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsBulkGithubRegisterOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">person_add</span>
            Register via Temp-Mail (GitHub)
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Provision brand-new GitHub accounts via disposable email (Privatix) and chain each one into CodeBuddy OAuth in a single job. Just press start — emails, usernames, and passwords are generated automatically. Requires a proxy pool with unique proxies per account.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsBulkTokenOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">playlist_add</span>
            Bulk Token Import
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Paste multiple access tokens directly. No browser needed.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">login</span>
            Device OAuth Login
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Open CodeBuddy browser login and poll until the access token is saved.
          </span>
        </button>
      </div>
      <CodeBuddyBulkTokenModal
        isOpen={isBulkTokenOpen && !disabled}
        disabled={disabled}
        onClose={() => setIsBulkTokenOpen(false)}
        onSuccess={onRefresh}
      />
      <CodeBuddyProxyOAuthModal
        isOpen={isWrapOpen && !disabled}
        disabled={disabled}
        onSuccess={onRefresh}
        onClose={() => setIsWrapOpen(false)}
      />
      <BulkAccountAutomationModal
        isOpen={isBulkOpen && !disabled}
        provider="codebuddy"
        title="CodeBuddy Bulk GSuite Login"
        serviceName="CodeBuddy"
        enableProxyPool
        // CodeBuddy Global GSuite bulk physically requires one unique proxy
        // per Camoufox worker. Auto pool is fine, direct mode is not.
        requireProxyPool
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
      <BulkAccountAutomationModal
        isOpen={isBulkGithubOpen && !disabled}
        provider="codebuddy-github"
        title="CodeBuddy Bulk Login (GitHub SSO)"
        serviceName="CodeBuddy (GitHub)"
        accountFormat="github_username_or_email|password"
        introText="Sign up / log in CodeBuddy Global via GitHub SSO. One github_username_or_email|password per line. Choose Auto pool for maximum IP isolation, a specific pool for a curated set, or None (direct) to use the host IP. Accounts that hit GitHub 2FA, device verification, or CAPTCHA move to manual assist."
        enableProxyPool
        // GitHub SSO tolerates direct mode for small batches; leave the
        // choice to the operator via the Auto pool / None / specific pool
        // dropdown.
        onSuccess={onRefresh}
        onClose={() => setIsBulkGithubOpen(false)}
      />
      <BulkAccountAutomationModal
        isOpen={isBulkGithubRegisterOpen && !disabled}
        provider="codebuddy-github-register"
        title="CodeBuddy Bulk Register (GitHub via Temp-Mail)"
        serviceName="CodeBuddy (GitHub Register)"
        // Backend generates every credential; the modal replaces the
        // paste-accounts textarea with a numeric "how many?" input.
        accountCountMode
        introText="Provision fresh GitHub accounts through Privatix disposable email, then chain each one into CodeBuddy OAuth. One Camoufox context per account; every account lands on a different temp-mail domain. Requires a proxy pool with one unique proxy per account (GitHub blocks repeat signups from the same exit IP). Accounts that hit octocaptcha, phone verification, or OTP timeout move to manual assist."
        enableProxyPool
        // Unlike the bulk-login variant, register REQUIRES a proxy pool. The
        // manager also enforces "one unique proxy per account" server-side,
        // so this UI-level requireProxyPool guard is defense-in-depth.
        requireProxyPool
        // Concurrency ceiling is intentionally lower for register: each
        // worker holds a Camoufox context through a multi-minute signup +
        // OAuth flow, and GitHub's rate limits punish parallel signups from
        // adjacent IPs.
        defaultConcurrency={2}
        maxConcurrency={4}
        onSuccess={onRefresh}
        onClose={() => setIsBulkGithubRegisterOpen(false)}
      />
      <OAuthModal
        isOpen={isOpen && !disabled}
        provider="codebuddy"
        providerInfo={providerInfo}
        onSuccess={() => {
          onRefresh?.();
          setIsOpen(false);
        }}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}

function CodeBuddyCnAutomationPanel({ providerInfo, onRefresh, disabled = false }) {
  const [isOAuthOpen, setIsOAuthOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isWrapOpen, setIsWrapOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={() => setIsOAuthOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">login</span>
            OAuth Login
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Open the CodeBuddy CN device OAuth flow and save the returned credentials.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsBulkOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">group_add</span>
            5sim Bulk Registration
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Register CodeBuddy CN accounts with isolated Camoufox workers and your 5sim API key.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsWrapOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">vpn_lock</span>
            OAuth via Proxy
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Open the official CodeBuddy CN OAuth login through an active proxy pool and save access/refresh tokens without creating an API key.
          </span>
        </button>
      </div>
      <OAuthModal
        isOpen={isOAuthOpen && !disabled}
        provider="codebuddy-cn"
        providerInfo={providerInfo}
        onSuccess={() => {
          onRefresh?.();
          setIsOAuthOpen(false);
        }}
        onClose={() => setIsOAuthOpen(false)}
      />
      <CodeBuddyCnAutomationModal
        isOpen={isBulkOpen && !disabled}
        disabled={disabled}
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
      <CodeBuddyCnAutomationModal
        isOpen={isWrapOpen && !disabled}
        disabled={disabled}
        mode="wrap-login"
        onSuccess={onRefresh}
        onClose={() => setIsWrapOpen(false)}
      />
    </>
  );
}

function QoderAutomationPanel({ providerInfo, onRefresh, disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={() => setIsBulkOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">group_add</span>
            Auto Login Bulk
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Run bulk Google SSO login for Qoder with worker progress and manual assist.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={disabled}
          className={getAutomationCardClasses(disabled)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">login</span>
            Device OAuth Login
          </span>
          <span className="text-xs leading-relaxed text-text-muted">
            Open Qoder device login and poll until the access token is saved.
          </span>
        </button>
      </div>
      <BulkAccountAutomationModal
        isOpen={isBulkOpen && !disabled}
        provider="qoder"
        title="Qoder Bulk Google Login"
        serviceName="Qoder"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
      <OAuthModal
        isOpen={isOpen && !disabled}
        provider="qoder"
        providerInfo={providerInfo}
        onSuccess={() => {
          onRefresh?.();
          setIsOpen(false);
        }}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}

const AUTOMATION_PROVIDERS = [
  {
    id: "kiro",
    label: "Kiro AI",
    description: "Token import, bulk import, and social login automation.",
    supportedModes: ["single-token", "bulk-token", "bulk-account", "social"],
    component: KiroAutomationPanel,
  },
  {
    id: "qoder",
    label: "Qoder",
    description: "Bulk Google SSO automation and browser device login polling.",
    supportedModes: ["bulk-account", "device-oauth"],
    component: QoderAutomationPanel,
  },
  {
    id: "codebuddy",
    label: "CodeBuddy",
    description: "Bulk GSuite / GitHub automation and browser OAuth polling login.",
    supportedModes: ["bulk-account", "github-bulk", "device-oauth", "wrap-login"],
    component: CodeBuddyAutomationPanel,
  },
  {
    id: "codebuddy-cn",
    label: "CodeBuddy CN",
    description: "Device OAuth, 5sim-assisted bulk registration, and proxy-routed OAuth login.",
    supportedModes: ["oauth", "5sim-bulk", "wrap-login"],
    component: CodeBuddyCnAutomationPanel,
  },
];

export default function AutomationPage() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeProviderId, setActiveProviderId] = useState(() => {
    if (typeof window === "undefined") return AUTOMATION_PROVIDERS[0].id;
    const requested = new URLSearchParams(window.location.search).get("provider");
    return AUTOMATION_PROVIDERS.some((provider) => provider.id === requested)
      ? requested
      : AUTOMATION_PROVIDERS[0].id;
  });

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setConnections(data.connections || []);
    } catch (error) {
      console.log("Error fetching automation connections:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The async callback updates state after I/O, not synchronously in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchConnections updates only after the network request settles.
    void fetchConnections();
  }, [fetchConnections]);

  const activeProvider = AUTOMATION_PROVIDERS.find((provider) => provider.id === activeProviderId) || AUTOMATION_PROVIDERS[0];
  const providerInfo = AI_PROVIDERS[activeProvider.id] || { id: activeProvider.id, name: activeProvider.label };
  const ProviderPanel = activeProvider.component;
  const providerStates = useMemo(() => {
    const states = {};
    for (const provider of AUTOMATION_PROVIDERS) {
      const providerConnections = connections.filter((connection) => connection.provider === provider.id);
      states[provider.id] = {
        count: providerConnections.length,
        disabled: (AI_PROVIDERS[provider.id]?.systemDisabled === true)
          || isProviderDisabledFromConnections(providerConnections),
      };
    }
    return states;
  }, [connections]);
  const activeProviderState = providerStates[activeProvider.id] || { count: 0, disabled: false };
  const providerDisabledMessage = getProviderDisabledMessage(providerInfo, activeProvider.id);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Automation</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {AUTOMATION_PROVIDERS.map((provider) => {
          const selected = provider.id === activeProviderId;
          const providerMeta = AI_PROVIDERS[provider.id] || null;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => setActiveProviderId(provider.id)}
              className={`flex min-w-0 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                selected
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-surface text-text-main hover:border-primary/30 hover:bg-primary/5"
              }`}
            >
              <AutomationProviderIcon providerId={provider.id} providerMeta={providerMeta} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="block truncate text-sm font-semibold">{provider.label}</span>
                  {providerMeta?.statusLabel && (
                  <Badge variant="error" size="sm">
                      {providerMeta.statusLabel}
                    </Badge>
                  )}
                  {providerStates[provider.id]?.disabled && (
                    <Badge variant="warning" size="sm">
                      Disabled
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {getConnectionLabel(providerStates[provider.id]?.count || 0)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <Card>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <AutomationProviderIcon providerId={activeProvider.id} providerMeta={providerInfo} />
                <h2 className="text-lg font-semibold">{activeProvider.label}</h2>
                {providerInfo.statusLabel && (
                  <Badge variant="error" size="sm">
                    {providerInfo.statusLabel}
                  </Badge>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeProvider.supportedModes.map((mode) => (
                  <Badge key={mode} variant="default" size="sm">
                    {mode}
                  </Badge>
                ))}
              </div>
            </div>
            <Badge variant={activeProviderState.disabled ? "warning" : "success"}>
              {getConnectionLabel(activeProviderState.count || 0)}
            </Badge>
          </div>

          {activeProviderState.disabled && (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
              providerInfo?.systemDisabled
                ? "border border-red-500/30 bg-red-500/10"
                : "border border-amber-500/30 bg-amber-500/10"
            }`}>
              <span className={`material-symbols-outlined text-[16px] ${
                providerInfo?.systemDisabled ? "text-red-500" : "text-amber-500"
              }`}>block</span>
              <p className={`text-xs leading-relaxed ${
                providerInfo?.systemDisabled ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-300"
              }`}>{providerDisabledMessage}</p>
            </div>
          )}

          {providerInfo.statusNotice && !providerInfo.systemDisabled && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              <span className="material-symbols-outlined text-[16px] text-red-500">block</span>
              <p className="text-xs leading-relaxed text-red-600 dark:text-red-400">{providerInfo.statusNotice}</p>
            </div>
          )}

          <ProviderPanel
            providerInfo={providerInfo}
            onRefresh={fetchConnections}
            disabled={activeProviderState.disabled}
          />
        </div>
      </Card>
    </div>
  );
}
