"use client";

/**
 * lazyOS — Web-Push Subscribe-Button
 *
 * SSR-safe: all PWA APIs are only touched in useEffect / onClick.
 * Style: .qc button.p (primary QCK button from LazyOS Manifest v1.0).
 *
 * State machine:
 *   unsupported  — browser cannot push (iOS < 16.4, Safari without PWA, etc.)
 *   idle         — permission "default", not subscribed
 *   subscribed   — subscription is on the server, Notification.permission === "granted"
 *   blocked      — permission "denied" (user must unblock manually in settings)
 *   working      — transitional status during register/subscribe/unsubscribe
 *   error        — last attempt failed, message visible
 */

import { useCallback, useEffect, useState } from "react";
import { urlBase64ToUint8Array } from "./vapid";

type State = "loading" | "unsupported" | "idle" | "subscribed" | "blocked" | "working" | "error";

interface Props {
  vapidPublicKey: string;
}

export function SubscribeButton({ vapidPublicKey }: Props) {
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState<string>("");

  // Initialer Sync: Support-Check + bestehende Subscription lesen
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (typeof window === "undefined") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        if (!cancelled) setState("unsupported");
        return;
      }
      // iOS Safari benoetigt PWA-Install (standalone) fuer Push
      const isStandalone =
        window.matchMedia?.("(display-mode: standalone)").matches ||
        // iOS-spezifisches Flag auf Navigator
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (isIOS && !isStandalone) {
        if (!cancelled) {
          setState("unsupported");
          setMessage("iOS: zuerst zum Home-Screen hinzufuegen, dann PWA oeffnen.");
        }
        return;
      }

      if (Notification.permission === "denied") {
        if (!cancelled) setState("blocked");
        return;
      }

      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const existing = await reg?.pushManager.getSubscription();
        if (!cancelled) {
          if (existing && Notification.permission === "granted") {
            setState("subscribed");
          } else {
            setState("idle");
          }
        }
      } catch {
        if (!cancelled) setState("idle");
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    if (!vapidPublicKey) {
      setState("error");
      setMessage("VAPID-Public-Key fehlt. Env-Var pruefen.");
      return;
    }
    setState("working");
    setMessage("");
    try {
      const reg =
        (await navigator.serviceWorker.getRegistration("/")) ??
        (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));

      // Warten bis SW aktiv ist (first install)
      if (reg.installing) {
        await new Promise<void>((resolve) => {
          const sw = reg.installing!;
          sw.addEventListener("statechange", () => {
            if (sw.state === "activated") resolve();
          });
        });
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "idle");
        return;
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server lehnt Subscription ab (${res.status}): ${text}`);
      }

      setState("subscribed");
      setMessage("Push aktiviert. Du bekommst Phase-Drops als Notification.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState("error");
      setMessage(msg);
    }
  }, [vapidPublicKey]);

  const unsubscribe = useCallback(async () => {
    setState("working");
    setMessage("");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const existing = await reg?.pushManager.getSubscription();
      if (existing) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        }).catch(() => undefined);
        await existing.unsubscribe();
      }
      setState("idle");
      setMessage("Push deaktiviert.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState("error");
      setMessage(msg);
    }
  }, []);

  // Render
  const { label, sub, onClick, disabled, tone } = (() => {
    switch (state) {
      case "loading":
        return { label: "lade...", sub: "", onClick: undefined, disabled: true, tone: "p" as const };
      case "unsupported":
        return {
          label: "Nicht unterstuetzt",
          sub: "iOS 16.4+, zum Home-Screen hinzufuegen",
          onClick: undefined,
          disabled: true,
          tone: "s" as const,
        };
      case "blocked":
        return {
          label: "Blockiert",
          sub: "Berechtigung in den Browser-Settings entsperren",
          onClick: undefined,
          disabled: true,
          tone: "s" as const,
        };
      case "idle":
        return {
          label: "Push aktivieren",
          sub: "Phase-Drops als Notification",
          onClick: subscribe,
          disabled: false,
          tone: "p" as const,
        };
      case "subscribed":
        return {
          label: "Aktiviert",
          sub: "Klicken zum Deaktivieren",
          onClick: unsubscribe,
          disabled: false,
          tone: "s" as const,
        };
      case "working":
        return { label: "Moment...", sub: "", onClick: undefined, disabled: true, tone: "p" as const };
      case "error":
        return {
          label: "Nochmal versuchen",
          sub: "Fehler aufgetreten",
          onClick: subscribe,
          disabled: false,
          tone: "p" as const,
        };
    }
  })();

  return (
    <div className="qc" style={{ maxWidth: "360px", gridTemplateColumns: "1fr" }}>
      <button
        type="button"
        className={tone === "p" ? "p" : undefined}
        onClick={onClick}
        disabled={disabled}
        aria-label={`${label}. ${sub}`}
        aria-busy={state === "working"}
        style={{ opacity: disabled ? 0.55 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
      >
        {label}
        <small>{sub || "\u00A0"}</small>
      </button>
      <p
        aria-live="polite"
        role="status"
        style={{
          fontSize: "11px",
          color: state === "error" ? "var(--a-danger)" : "var(--ink-3)",
          marginTop: "10px",
          minHeight: "14px",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.02em",
          textAlign: "left",
        }}
      >
        {message}
      </p>
    </div>
  );
}
