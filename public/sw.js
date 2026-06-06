/**
 * lazyOS Service Worker — v0.1
 *
 * Scope: / (MUSS Root-Scope sein, iOS-Safari + Chrome erwarten das).
 * Zustaendig:
 *   - Web-Push Empfang + Notifikations-Anzeige
 *   - Click-Handler: oeffnet/fokussiert PWA und navigiert zu data.url
 *   - Minimaler Install-Cache (Shell-Seite offline-lesbar)
 *
 * KEINE runtime-Caches fuer /api/* — Push-Daten sind live.
 */

/* global self */

const VERSION = "lazyos-v80-css-cachebust";
const SHELL_CACHE = `${VERSION}-shell`;
// 2026-06-06: do NOT precache "/" (HTML). HTML references hash-named CSS/JS that
// change every build; a precached old "/" served as offline fallback = blank page
// with dead CSS hashes (the mobile "white page" bug). Precache only static shell
// assets; navigation is network-only (see fetch handler). Bump VERSION to evict
// any poisoned caches from earlier builds on the next activate.
const SHELL_URLS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("lazyos-") && !k.startsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: network-first fuer navigations, cache fallback fuer shell. API-Requests nie cachen.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // 2026-04-27 Bugfix: KEIN cached HTML mehr fuer Navigations zurueckgeben.
    // Der HTML referenziert hash-named CSS-/JS-Bundles, die nach jedem Build
    // andere Namen haben. Cached HTML aus altem Build -> 404 auf neuen CSS-
    // Hash -> "weißer Hintergrund, nur Text". Network-only fuer Navigations.
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match("/")
          .then((hit) => hit || new Response("offline", { status: 503 })),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = { title: "lazyOS", body: "Neue Nachricht", url: "/" };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  const { title, body, url, tag, renotify, ruleId } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: tag ?? "lazyos-default",
      renotify: renotify ?? true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Pattern 6a Telemetrie (2026-05-01): ruleId + tag in data damit der
      // notificationclick + notificationclose-Handler /api/push/feedback
      // mit der Rule-Identität callen kann.
      data: { url: url ?? "/", ruleId: ruleId ?? null, tag: tag ?? null },
      requireInteraction: false,
    }),
  );
});

// Pattern 6a Push-Telemetrie (2026-05-01): fire-and-forget Feedback-Call.
// SW läuft same-origin → Browser sendet HttpOnly `lazyos_session` Cookie
// automatisch mit credentials:'include'. Server-Endpoint akzeptiert
// Cookie ODER Bearer.
async function postFeedback(action, ruleId, tag) {
  if (!ruleId) return; // Push ohne ruleId → keine Telemetrie möglich
  try {
    await fetch("/api/push/feedback", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId, action, tag: tag ?? undefined }),
    });
  } catch {
    /* fire-and-forget; offline = Telemetrie verloren, kein Retry */
  }
}

// 2026-04-26: PUSH-NAV via Cache-API-Pending-State.
// Bekanntes iOS-PWA-Problem: openWindow + navigate ignorieren oft die
// target-URL und oeffnen Last-Visited-Page. Workaround:
//  1. SW schreibt target in Cache-API Eintrag 'lazyos-pending-nav'
//  2. SW versucht trotzdem postMessage + openWindow (Best-Effort)
//  3. Client beim Mount liest Cache, navigiert hin, cleared Cache
//  4. Selbst wenn iOS auf Last-Visited-Page oeffnet, navigiert der
//     Client-Code danach SOFORT zum target
async function setPendingNav(target) {
  try {
    const cache = await caches.open(`${VERSION}-runtime`);
    const payload = JSON.stringify({ url: target, ts: Date.now() });
    await cache.put(
      "/__lazyos_pending_nav__",
      new Response(payload, {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    /* ignore — best effort */
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";
  const ruleId = event.notification.data?.ruleId ?? null;
  const tag = event.notification.data?.tag ?? null;
  event.waitUntil(
    (async () => {
      // Pattern 6a: Telemetrie clicked (fire-and-forget, blockt Nav nicht)
      void postFeedback("clicked", ruleId, tag);

      // 1. Pending-Nav schreiben — Client liest beim Mount/visibility-change
      await setPendingNav(target);

      // 2. Wenn PWA-Tab offen: focus + postMessage + navigate (alle 3)
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
        } catch {
          continue;
        }
        if ("focus" in client) {
          await client.focus().catch(() => undefined);
        }
        try {
          client.postMessage({ type: "lazyos:navigate-to", url: target });
        } catch {
          /* postMessage manchmal denied */
        }
        if ("navigate" in client) {
          client.navigate(target).catch(() => undefined);
        }
        return;
      }

      // 3. Kein Tab offen: openWindow versuchen. iOS-PWA ignoriert dabei oft
      //    die URL — egal, der Client liest dann beim Mount aus Cache und
      //    navigiert nachtraeglich. Belt-and-suspenders.
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })(),
  );
});

// Pattern 6a Push-Telemetrie (2026-05-01): notificationclose feuert wenn der
// User die Notification ohne Klick aktiv schließt (Swipe / X). Nicht alle
// Browser feuern dieses Event zuverlässig (iOS Safari: nicht garantiert),
// aber Chrome/Firefox/Edge ja — und wir sind im Single-User-Setup primär
// Chrome+iOS. Best-effort.
self.addEventListener("notificationclose", (event) => {
  const ruleId = event.notification?.data?.ruleId ?? null;
  const tag = event.notification?.data?.tag ?? null;
  event.waitUntil(postFeedback("dismissed", ruleId, tag));
});
