"use client";

import { useEffect, useState } from "react";

/**
 * Service-worker registration and the Android install prompt.
 *
 * Installing is entirely optional — the site works the same in a browser tab —
 * but on Android an installed icon removes the browser chrome from a loop the
 * operator runs all day. The prompt only ever appears when the browser itself
 * offers it, and dismissing it is remembered.
 */

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const DISMISSED_KEY = "dm-setter-install-dismissed";

export function useInstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // The worker only caches build assets; nothing private is stored offline.
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unavailable worker costs installability, never functionality.
      });
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      let dismissed = false;
      try {
        dismissed = window.localStorage.getItem(DISMISSED_KEY) === "1";
      } catch {
        // Private mode: treat as not dismissed.
      }
      if (!dismissed) setEvent(e as InstallEvent);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", () => setEvent(null));
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const install = async () => {
    if (!event) return;
    await event.prompt();
    await event.userChoice.catch(() => undefined);
    setEvent(null);
  };

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Nothing to do; it will simply be offered again next time.
    }
    setEvent(null);
  };

  return { canInstall: event !== null, install, dismiss };
}

export function InstallBanner() {
  const { canInstall, install, dismiss } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <div className="m-install" role="note">
      <span>Add to your home screen for one-tap access.</span>
      <span className="spacer" />
      <button className="m-link" onClick={() => void install()}>
        Install
      </button>
      <button className="m-link" onClick={dismiss} aria-label="Dismiss install prompt">
        Not now
      </button>
    </div>
  );
}
