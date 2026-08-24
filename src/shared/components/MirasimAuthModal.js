"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

/**
 * Mirasim Auth Modal
 * Imports the locally-installed Mirasim desktop account by decrypting ~/.mirasim,
 * so the relay can be used without the Mirasim app running.
 *
 * Requires 9router to run as the same OS user that installed Mirasim — the master
 * key is keychain/DPAPI-scoped to that user.
 */
export default function MirasimAuthModal({ isOpen, onSuccess, onClose }) {
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);

  const runDetect = async () => {
    setDetecting(true);
    setError(null);
    setDetected(null);

    try {
      const res = await fetch("/api/oauth/mirasim/import-local");
      const data = await res.json();
      if (data.found) {
        setDetected(data);
      } else {
        setError(data.error || "Could not read the local Mirasim installation");
      }
    } catch {
      setError("Failed to read the local Mirasim installation");
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    runDetect();
  }, [isOpen]);

  const handleImport = async () => {
    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/mirasim/import-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Mirasim" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {detecting && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Reading local Mirasim...</h3>
            <p className="text-sm text-text-muted">
              Decrypting credentials from ~/.mirasim
            </p>
          </div>
        )}

        {!detecting && (
          <>
            {detected && (
              <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800 flex flex-col gap-2">
                <div className="flex gap-2">
                  <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                  <p className="text-sm text-green-800 dark:text-green-200">
                    Local Mirasim account detected.
                  </p>
                </div>
                <div className="text-xs text-green-800 dark:text-green-200 flex flex-col gap-0.5 pl-7">
                  {detected.name && <span>Account: {detected.name}</span>}
                  {detected.deviceId && <span className="font-mono">Device: {detected.deviceId}</span>}
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800 flex flex-col gap-2">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                <p className="text-xs text-red-600/80 dark:text-red-400/80">
                  Sign in to the Mirasim desktop app once, and make sure 9router runs as the same
                  OS user — the credential key is scoped to that user.
                </p>
                <Button onClick={runDetect} variant="outline" fullWidth>
                  Retry
                </Button>
              </div>
            )}

            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Imports the account and device key so requests are signed directly — the Mirasim
                  app does not need to be running.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleImport} fullWidth disabled={importing || !detected}>
                {importing ? "Importing..." : "Import Account"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

MirasimAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
