"use client";

import { useEffect, useState } from "react";
import { translate, getCurrentLocale } from "@/i18n/runtime";
import { offPeakStatus, promotionText, formatCountdown } from "@/shared/utils/offPeak";

/**
 * Live countdown strip for a provider's off-peak pricing window (Qoder:
 * 22:00–08:00 Asia/Singapore). Mirrors the official client: counts down to
 * the window while it is closed, and to the return of standard pricing
 * while it is open. Renders nothing unless the promotion carries a usable
 * window — one shared interval for the whole model list (rows themselves
 * stay static badges; only this strip ticks).
 */
export default function OffPeakBanner({ promotion }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const status = offPeakStatus(promotion, now);
  if (!status) return null;
  const badge = promotionText(promotion?.badge, getCurrentLocale());
  const desc = promotionText(promotion?.description, getCurrentLocale());
  const time = formatCountdown(status.secondsToBoundary);
  const text = status.active
    ? `${translate("Off-peak discount active")} · ${time} ${translate("until standard rate")}`
    : `${time} ${translate("until off-peak discount")}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400"
      title={desc || undefined}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>eco</span>
      <span className="font-medium">{text}</span>
      {badge && <span className="opacity-80">· {badge}</span>}
      <span className="ml-auto font-mono opacity-60">
        {status.windowLabel} {status.timezone}
      </span>
    </div>
  );
}
