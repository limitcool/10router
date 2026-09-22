"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { translate } from "@/i18n/runtime";

// Dashboard-wide security banner (issue #9, items 3 and 4).
//
// The endpoint page has had its own warnings for a while, but the two states
// that actually decide whether this instance is safe — no dashboard password at
// all, and the login check switched off — were only visible inside pages an
// operator might never open. This puts them above every page until they are
// fixed.
//
// Renders nothing while loading and on any error: /api/security/status is
// auth-gated (a remote caller gets 403), and a failed probe must not turn into a
// scary banner.
export default function SecurityBanner() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/security/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const noPassword = !status.hasPassword && !status.bootstrapPassword && !status.ssoConfigured;
  const loginOff = status.requireLogin === false;
  if (!noPassword && !loginOff) return null;

  // Login-off is the louder of the two: the port is open to whoever can route to
  // it. No-password only closes the dashboard to other machines.
  const message = loginOff
    ? translate("Log-in check is off — anyone who can reach this port can manage every provider, key and credential.")
    : translate("No dashboard password is set — the dashboard opens on this machine only. Set one on the Settings page.");

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400">
      <span className="material-symbols-outlined text-[18px] shrink-0">warning</span>
      <p className="text-xs flex-1">{message}</p>
      <Link href="/dashboard/profile" className="text-xs font-medium underline shrink-0 hover:opacity-80">
        {translate("Open Settings")}
      </Link>
    </div>
  );
}
