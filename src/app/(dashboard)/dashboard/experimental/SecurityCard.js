"use client";

import { useEffect, useState } from "react";
import { Card, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";

// Security card (Settings → Experimental). Two halves on purpose:
//   * the switches — dashboard local-only, one click, takes effect on the next
//     request (the guard reads the setting per request, no restart);
//   * the read-out — what is actually exposed right now. The audit behind issue
//     #9 found the real problem was a *stack* of defaults (0.0.0.0 listener +
//     "123456" fallback + plaintext credentials) that nobody could see from the
//     UI. The fallback is gone; this is the part that makes the rest visible.
function Row({ label, value, tone = "default" }) {
  const toneClass =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "ok"
          ? "text-green-600 dark:text-green-400"
          : "text-text-main";
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-border/50 last:border-0">
      <span className="text-xs sm:text-sm text-text-muted shrink-0">{label}</span>
      <span className={`text-xs sm:text-sm font-medium text-right break-all ${toneClass}`}>{value}</span>
    </div>
  );
}

export default function SecurityCard({ settings, patch }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/security/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const localOnly = settings.dashboardLocalOnly === true;
  const listenHost = info?.listenHost || null;
  const loopbackOnlyListener = ["127.0.0.1", "localhost", "::1"].includes(String(listenHost || "").toLowerCase());
  const lanUrls = (info?.lanAddresses || []).map((a) => `http://${a.address}${info?.port ? `:${info.port}` : ""}`);

  const noPassword = info ? !info.hasPassword && !info.bootstrapPassword && !info.ssoConfigured : false;
  const loginOff = info ? info.requireLogin === false : false;
  // The dashboard's real reach, which is not just this switch: with no password
  // set (and no SSO) the guard refuses non-local callers outright, so a row
  // reading "anyone who can reach the port" would flatly contradict the sentence
  // right below it saying remote access is off.
  const localOnlyEffective = localOnly || (noPassword && !loginOff);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="size-10 rounded-lg flex items-center justify-center bg-emerald-500/10 text-emerald-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">shield</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">{translate("Security")}</h3>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">{translate("Dashboard: local access only")}</p>
            <p className="text-xs sm:text-sm text-text-muted">
              {translate("Refuse every non-local request to the dashboard and its management APIs. The LLM API (/v1) is unaffected — it uses its own API keys. Takes effect immediately; you will lose remote access to this dashboard until you turn it off from the machine itself.")}
            </p>
          </div>
          <Toggle
            checked={localOnly}
            onChange={() =>
              patch(
                { dashboardLocalOnly: !localOnly },
                "Error toggling dashboard local-only mode:"
              )
            }
          />
        </div>

        {info && (
          <div className="pt-2 border-t border-border/50">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide pt-2 pb-1">
              {translate("Exposure")}
            </p>
            <Row
              label={translate("Listener")}
              value={listenHost ? listenHost : translate("Unknown")}
              tone={loopbackOnlyListener ? "ok" : "default"}
            />
            {!loopbackOnlyListener && lanUrls.length > 0 && (
              <Row label={translate("Reachable on the LAN at")} value={lanUrls.join("  ")} />
            )}
            <Row
              label={translate("Dashboard password")}
              value={
                info.hasPassword
                  ? translate("Password is set")
                  : info.bootstrapPassword
                    ? translate("Set by INITIAL_PASSWORD")
                    : info.ssoConfigured
                      ? translate("Sign-in is delegated to SSO")
                      : translate("No password set")
              }
              tone={info.hasPassword || info.bootstrapPassword || info.ssoConfigured ? "ok" : "danger"}
            />
            <Row
              label={translate("Log-in check")}
              value={info.requireLogin ? translate("Sign-in is required") : translate("Sign-in is off")}
              tone={info.requireLogin ? "ok" : "danger"}
            />
            <Row
              label={translate("Dashboard access")}
              value={
                localOnlyEffective
                  ? translate("This machine only")
                  : loginOff
                    ? translate("Anyone who can reach the port")
                    : translate("Anyone who can reach the port and knows the password")
              }
              tone={localOnlyEffective ? "ok" : "warn"}
            />
            {/* Issue #9, item 2 — read from the database rather than assumed:
                a row whose key material could not be created stays in the
                clear, and "everything is green" would then be a lie. */}
            <Row
              label={translate("Credential storage")}
              value={
                info.credentialsEncrypted === true
                  ? translate("Encrypted in the local database (AES-256-GCM)")
                  : info.credentialsEncrypted === false
                    ? translate("Plain text in the local database — encryption failed, check the data directory")
                    : translate("Unknown")
              }
              tone={info.credentialsEncrypted === true ? "ok" : "warn"}
            />
            {info.credentialsEncrypted === true && (
              <p className="text-xs text-text-muted pt-2">
                {translate("The key lives outside the database, so a copied data.sqlite alone cannot be read. Back up the key file with the database, or set CREDENTIAL_SECRET.")}
              </p>
            )}
            {noPassword && !loginOff && (
              <p className="text-xs text-red-600 dark:text-red-400 pt-2">
                {translate("No password is set yet, so the dashboard opens on this machine only. Set a password on the Settings page to reach it from other devices. The gateway API (/v1) is unaffected.")}
              </p>
            )}
            {loginOff && (
              <p className="text-xs text-red-600 dark:text-red-400 pt-2">
                {translate("Log-in check is off: anyone who can reach this port can manage every provider and credential. Turn it on again on the Settings page.")}
              </p>
            )}          </div>
        )}
      </div>
    </Card>
  );
}
