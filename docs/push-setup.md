# laz.ing — PWA install + web push setup

Set this up once, then approval prompts and notifications arrive on your iPhone
and desktop. Replace `https://your-instance.example.com/` below with your own
public URL.

---

## 1 · iOS Safari (iPhone / iPad, iOS 16.4 or newer)

Apple allows web push on iOS **only from an installed PWA**. These steps are
mandatory:

1. Open Safari at your production URL: **https://your-instance.example.com/**
2. Bottom bar: **Share button** (square with an up arrow).
3. Scroll → **"Add to Home Screen"** → **"Add"**.
4. Home screen: tap the laz.ing icon once.
5. The PWA opens in standalone mode (no Safari bar).
6. Scroll to **"Enable push"** → tap the button.
7. iOS asks for permission → **"Allow"**.
8. The button shows **"Enabled"** (dimmed).

After that, notifications appear in the iOS Notification Center even when the PWA
is closed.

### iOS gotchas

- Safari, not Chrome: Chrome on iOS uses Safari WebKit internally but offers no
  "Add to Home Screen". The only path is via Safari directly.
- iOS < 16.4: no web push. Update the device.
- Focus mode: an active Focus can suppress notifications. Turn it off briefly.
- If the icon after "Add" is just the default globe icon: uninstall the PWA once
  (hold the icon → delete app), repeat steps 1-4, and refresh the Safari cache
  with `https://your-instance.example.com/?v=2`.

---

## 2 · Desktop (Chrome / Edge / Brave / Safari 16.4+)

1. Visit **https://your-instance.example.com/**.
2. (Optional) Chrome/Edge address bar: small install icon (computer with a down
   arrow) → **"Install"** → laz.ing runs as its own app.
3. Scroll to **"Enable push"** → tap the button.
4. Browser dialog: **"Allow"**.
5. Done. Notifications appear as system popups (macOS Notification Center,
   Windows Action Center).

### Desktop gotchas

- Safari desktop: push works from 16.4. Upgrade old macOS versions.
- Firefox has supported web push for years.
- If blocked once and stuck on "Blocked": browser settings → notifications →
  your instance host → set "Allow" manually, then reload the page.

---

## 3 · Test push from the terminal (VPS or local)

```bash
cd <INSTALL_DIR>
node scripts/send-push.mjs \
  "Phase 1 done" \
  "16 components live. Tap to review." \
  "/review/phase-1"
```

The script reads `LAZYOS_PUSH_SECRET` from `.env.local`. Output:

```json
{
  "ok": true,
  "sent": 1,
  "removed": 0,
  "failures": 0,
  "errors": []
}
```

`sent: 1` means your subscription is on the server and the notification was sent
to Apple Push or FCM. It appears on the device within seconds.

### Send-API contract

`POST https://your-instance.example.com/api/push/send`

Header: `Authorization: Bearer <LAZYOS_PUSH_SECRET>` · `Content-Type: application/json`

Body:
```json
{
  "title": "Phase 1 done",
  "body": "16 components live.",
  "url": "/review/phase-1",
  "tag": "phase-drop"
}
```

- `title` required (otherwise fallback "laz.ing")
- `body` required-ish (otherwise empty)
- `url` must start with `/` (otherwise fallback `/`)
- `tag` optional: multiple sends with the same tag replace each other in the
  Notification Center (no notification flood from retry hooks)

---

## 4 · Auto-trigger from hooks (later)

Once a "phase completed" hook exists:

```bash
# inside the hook, after a successful deploy
node <INSTALL_DIR>/scripts/send-push.mjs \
  "Phase $PHASE done" \
  "$COMMIT_SHORT · $(date +%H:%M)" \
  "/review/phase-$PHASE"
```

---

## 5 · Secrets

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — known on the client, harmless
- `VAPID_PRIVATE_KEY` — NEVER in the client bundle, server-side only
- `VAPID_SUBJECT` — `mailto:you@example.com`
- `LAZYOS_PUSH_SECRET` — bearer token for `/api/push/send`

All four live in `.env.local` (not committed) and your hosting provider's
production env. To regenerate:

```bash
cd <INSTALL_DIR>
node scripts/generate-vapid.mjs   # regenerate -> .env.local
# Then delete and re-create the 4 env vars in your hosting provider.
```

Caution: rotating the VAPID keys invalidates **all existing subscriptions**.
Every device then has to tap "Enable push" again.
