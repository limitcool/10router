const api = require("../api/client");
const { t } = require("../i18n");
const { confirm, pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { showMenuWithBack } = require("../utils/menuHelper");

// ANSI colors
const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m"
};

// Fresh random dashboard password for the reset flow. Deliberately not a
// literal: resetting used to restore the old public default, which is the
// resurrection path the issue #9 audit called out (a guessable password plus a
// 0.0.0.0 listener).
function generatePassword() {
  return require("crypto").randomBytes(12).toString("base64url");
}

/**
 * Show settings menu (tunnel + RTK + reset password)
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showSettingsMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: t("menus.settings.title"),
    breadcrumb,
    headerContent: async (data) => {
      const lines = [];

      // Tunnel section
      const tunnel = data?.tunnel || {};
      if (tunnel.enabled && tunnel.publicUrl) {
        lines.push(t("menus.settings.endpointLabel", { value: `${COLORS.green}${tunnel.publicUrl}/v1${COLORS.reset}` }));
        lines.push(t("menus.settings.tunnelLabel", { value: `${COLORS.green}${t("menus.settings.on")}${COLORS.reset} ${COLORS.dim}(${tunnel.shortId})${COLORS.reset}` }));
      } else {
        lines.push(t("menus.settings.endpointLabel", { value: `http://localhost:20128/v1` }));
        lines.push(t("menus.settings.tunnelLabel", { value: `${COLORS.red}${t("menus.settings.off")}${COLORS.reset} ${COLORS.dim}${t("menus.settings.localOnly")}${COLORS.reset}` }));
      }

      // RTK section
      const rtkOn = data?.settings?.rtkEnabled !== false;
      lines.push(t("menus.settings.rtkLabel", { value: `${rtkOn ? `${COLORS.green}${t("menus.settings.on")}${COLORS.reset}` : `${COLORS.red}${t("menus.settings.off")}${COLORS.reset}`} ${COLORS.dim}${t("menus.settings.tagTokenSaver")}${COLORS.reset}` }));
      const headroomOn = data?.settings?.headroomEnabled === true;
      lines.push(t("menus.settings.headroomLabel", { value: `${headroomOn ? `${COLORS.green}${t("menus.settings.on")}${COLORS.reset}` : `${COLORS.red}${t("menus.settings.off")}${COLORS.reset}`} ${COLORS.dim}(${data?.settings?.headroomUrl || "http://localhost:8787"})${COLORS.reset}` }));

      // Auth mode section
      const authMode = data?.settings?.authMode || "password";
      const authColor = authMode === "password" ? COLORS.green : COLORS.yellow;
      lines.push(t("menus.settings.authLabel", { value: `${authColor}${authMode.toUpperCase()}${COLORS.reset} ${COLORS.dim}${t("menus.settings.tagLoginMode")}${COLORS.reset}` }));

      return lines.join("\n");
    },
    refresh: async () => {
      const [tunnelRes, settingsRes] = await Promise.all([
        api.getTunnelStatus(),
        api.getSettings()
      ]);
      return {
        tunnel: tunnelRes.success ? (tunnelRes.data || {}) : {},
        settings: settingsRes.success ? (settingsRes.data || {}) : {}
      };
    },
    items: [
      {
        label: t("menus.settings.tunnelOn"),
        action: async () => { await enableTunnel(); return true; }
      },
      {
        label: t("menus.settings.tunnelOff"),
        action: async () => { await disableTunnel(); return true; }
      },
      {
        label: (d) => {
          const on = d?.settings?.rtkEnabled !== false;
          return t("menus.settings.rtkToggle", { state: on ? t("menus.settings.on") : t("menus.settings.off") });
        },
        action: async (d) => { await toggleRtk(d?.settings?.rtkEnabled !== false); return true; }
      },
      {
        label: (d) => {
          const on = d?.settings?.headroomEnabled === true;
          return t("menus.settings.headroomToggle", { state: on ? t("menus.settings.on") : t("menus.settings.off") });
        },
        action: async (d) => { await toggleHeadroom(d?.settings?.headroomEnabled === true); return true; }
      },
      {
        label: t("menus.settings.resetPassword"),
        action: async () => { await resetPassword(); return true; }
      },
      {
        label: (d) => {
          const mode = d?.settings?.authMode || "password";
          return mode === "password" ? t("menus.settings.authModeAlready") : t("menus.settings.authModeReset", { mode });
        },
        action: async () => { await resetAuthMode(); return true; }
      }
    ]
  });
}

/**
 * Reset authMode to "password" via API. Used when OIDC is misconfigured
 * and user is locked out of dashboard. CLI bypasses auth via x-9r-cli-token.
 */
async function resetAuthMode() {
  const ok = await confirm(t("menus.settings.resetAuthConfirm"));
  if (!ok) {
    showStatus(t("menus.settings.cancelled"), "info");
    await pause();
    return;
  }

  const result = await api.updateSettings({ authMode: "password" });
  if (result.success) {
    showStatus(t("menus.settings.authModeDone"), "success");
  } else {
    showStatus(t("menus.settings.failed", { error: result.error }), "error");
  }
  await pause();
}

/**
 * Enable tunnel via API
 */
async function enableTunnel() {
  showStatus(t("menus.settings.creatingTunnel"), "info");
  const result = await api.enableTunnel();

  if (result.success) {
    const { publicUrl, shortId, alreadyRunning } = result.data || {};
    if (alreadyRunning) {
      showStatus(t("menus.settings.tunnelRunning", { url: publicUrl }), "success");
    } else {
      showStatus(t("menus.settings.tunnelEnabled", { url: publicUrl, shortId }), "success");
    }
  } else {
    showStatus(t("menus.settings.failed", { error: result.error }), "error");
  }

  await pause();
}

/**
 * Disable tunnel via API
 */
async function disableTunnel() {
  const result = await api.disableTunnel();

  if (result.success) {
    showStatus(t("menus.settings.tunnelDisabled"), "success");
  } else {
    showStatus(t("menus.settings.failed", { error: result.error }), "error");
  }

  await pause();
}

/**
 * Toggle RTK (Token Saver) via API
 * @param {boolean} currentlyOn
 */
async function toggleRtk(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ rtkEnabled: next });
  if (result.success) {
    showStatus(t(next ? "menus.settings.tokenSaverEnabled" : "menus.settings.tokenSaverDisabled"), "success");
  } else {
    showStatus(t("menus.settings.failed", { error: result.error }), "error");
  }
  await pause();
}

async function toggleHeadroom(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ headroomEnabled: next });
  if (result.success) {
    showStatus(t(next ? "menus.settings.headroomEnabledMsg" : "menus.settings.headroomDisabledMsg"), "success");
  } else {
    showStatus(t("menus.settings.failed", { error: result.error }), "error");
  }
  await pause();
}

/**
 * Reset the dashboard password: clear the stored hash through the local-only
 * server route, then set a freshly generated random one and show it exactly
 * once. The route itself never returns a password, so the CLI mints it here -
 * the whole point is that nobody, including the operator, knows it in advance.
 */
async function resetPassword() {
  const ok = await confirm(t("menus.settings.resetPwConfirm"));
  if (!ok) {
    showStatus(t("menus.settings.cancelled"), "info");
    await pause();
    return;
  }

  const cleared = await api.resetPassword();
  if (!cleared.success) {
    showStatus(t("menus.settings.resetPwFailed", { error: cleared.error }), "error");
    await pause();
    return;
  }

  // With no hash stored the settings PATCH takes the first-set branch, so no
  // current password is required here.
  const generated = generatePassword();
  const saved = await api.updateSettings({ newPassword: generated });
  if (saved && saved.error) {
    showStatus(t("menus.settings.resetPwFailed", { error: saved.error }), "error");
  } else {
    showStatus(t("menus.settings.resetPwDone", { password: generated }), "success");
  }
  await pause();
}

module.exports = { showSettingsMenu };
