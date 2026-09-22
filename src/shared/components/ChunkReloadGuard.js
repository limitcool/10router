"use client";

import { useEffect } from "react";

/**
 * Reload the page once on a ChunkLoadError.
 *
 * After an upgrade — or when a leftover server from the previous build serves
 * an HTML shell that references chunk filenames the new build no longer ships —
 * a lazy/dynamic import fails with ChunkLoadError and the app goes blank. One
 * reload re-fetches the current HTML and its chunk map and recovers.
 *
 * Deliberately self-limiting: the marker lives for the tab's lifetime, so a
 * genuinely broken build reloads once and then fails visibly rather than
 * reload-looping. Mounted in the root layout, so it also covers client-side
 * navigations after the shell has hydrated (an initial-load failure means there
 * is nothing to hydrate and is handled by the stale-server banner instead).
 */
const RELOAD_MARKER = "_chunkReloadDone";

export function isChunkLoadError(err) {
  if (!err) return false;
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (name === "ChunkLoadError") return true;
  return /ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module/i.test(message);
}

export default function ChunkReloadGuard() {
  useEffect(() => {
    const reloadOnce = () => {
      try {
        if (window.sessionStorage.getItem(RELOAD_MARKER)) return;
        window.sessionStorage.setItem(RELOAD_MARKER, "1");
      } catch {
        // Private mode / storage disabled: better to not reload than to loop.
        return;
      }
      window.location.reload();
    };

    const onError = (event) => {
      if (isChunkLoadError(event?.error) || isChunkLoadError(event?.target?.error)) reloadOnce();
    };
    const onUnhandledRejection = (event) => {
      if (isChunkLoadError(event?.reason)) reloadOnce();
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
