/**
 * Push-Subscription-Store — MVP File-DB.
 *
 * WICHTIG — Vercel-Kontext:
 *   Vercel-Serverless-Filesystem ist ephemer. Jede Lambda-Instanz
 *   bekommt ihr eigenes /tmp und verliert es am Ende. Fuer ein
 *   1-User-MVP (Max) ist das ok — ein gelegentlicher Push-Reset ist
 *   kein Show-Stopper. Phase 2 migriert nach SQLite/Supabase.
 *
 *   Bei lokalem `next dev` (persistent) und ebenso bei schnell
 *   aufeinanderfolgenden Requests auf derselben Lambda-Instanz
 *   ueberlebt die Datei. Das deckt the owner's Testfall ab:
 *   SUBSCRIBE -> SEND -> NOTIFICATION innerhalb einer Minute.
 *
 * Wenn die Datei voellig fehlt (Cold-Start auf frischer Lambda), gibt
 * `list()` ein leeres Array zurueck und `send` sendet an niemanden —
 * bei Bedarf wird Max erneut subscriben.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PushSubscription as WebPushSubscription } from "web-push";

export interface StoredSubscription extends WebPushSubscription {
  createdAt: string;
  userAgent?: string;
}

const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "lazyos-data")
  : path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "push-subscriptions.json");

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "[]", "utf8");
  }
}

export async function list(): Promise<StoredSubscription[]> {
  try {
    await ensureFile();
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored);
  } catch {
    return [];
  }
}

async function writeAll(subs: StoredSubscription[]): Promise<void> {
  await ensureFile();
  await fs.writeFile(DATA_FILE, JSON.stringify(subs, null, 2), "utf8");
}

export async function upsert(sub: StoredSubscription): Promise<void> {
  const all = await list();
  const idx = all.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) all[idx] = sub;
  else all.push(sub);
  await writeAll(all);
}

export async function remove(endpoint: string): Promise<void> {
  const all = await list();
  const next = all.filter((s) => s.endpoint !== endpoint);
  if (next.length !== all.length) await writeAll(next);
}

function isStored(v: unknown): v is StoredSubscription {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.endpoint === "string" &&
    typeof obj.keys === "object" &&
    obj.keys !== null &&
    typeof (obj.keys as Record<string, unknown>).auth === "string" &&
    typeof (obj.keys as Record<string, unknown>).p256dh === "string"
  );
}
