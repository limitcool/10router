"use client";

import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * "Invite code + copy" chip. Rendered next to Get API Key / signup links for
 * providers that run referral programs (registry display.notice.inviteCode).
 */
export default function InviteCodeChip({ code, label = "Invite code" }) {
  const { copied, copy } = useCopyToClipboard();
  if (!code) return null;
  const isCopied = copied === "invite-code";
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-bg-alt px-1.5 py-0.5 text-xs text-text-muted whitespace-nowrap">
      <span>{label}</span>
      <code className="font-mono text-text-main">{code}</code>
      <button
        type="button"
        onClick={() => copy(code, "invite-code")}
        title="Copy invite code"
        className="inline-flex items-center text-text-muted hover:text-text transition-colors cursor-pointer"
      >
        <span className="material-symbols-outlined text-sm">{isCopied ? "check" : "content_copy"}</span>
      </button>
    </span>
  );
}
