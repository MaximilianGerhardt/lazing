# ADR 0002 — Daily SQLite snapshot + restore drill

**Status:** accepted (target procedure documented; implementation pending)  
**Date:** 2026-05-24  
**Deciders:** maintainers (autonomous decision)

---

## Context

- lazyOS uses SQLite via `better-sqlite3` as its primary DB (file: `data/lazyos.db`
  on a server, `.data/lazyos.db` locally).
- A production instance can hold dozens of migrations and tens of thousands of
  RAG chunks live. Data loss from a corrupt DB file would not be recoverable
  without a backup.
- No systematic backup procedure currently exists.

## Decision

**Target state (procedure):**

1. **Daily snapshot** via SQLite's own `VACUUM INTO` or `sqlite3 .backup`:
   ```bash
   sqlite3 "$LAZYOS_DB_PATH" ".backup '/path/to/backup/lazyos-$(date +%Y%m%d).db'"
   ```
   Backup target directory: `~/.lazyos/backups/` (local) or `/var/backups/lazyos/`
   (server). Retention: 7 days rolling.

2. **macOS LaunchAgent** (`~/Library/LaunchAgents/com.lazyos.db-backup.plist`)
   triggers the snapshot daily at 03:00 local time.
   The template lives in `systemd/lazyos-db-backup.plist.template` (TBD).

3. **Linux systemd timer** (`systemd-units/lazyos-db-backup.timer` + `.service`)
   for a server. Modeled on the existing units in `systemd-units/`.

4. **Restore drill** (monthly, manually documented):
   ```bash
   # stop the service
   launchctl unload ~/Library/LaunchAgents/com.lazyos.server.plist  # macOS
   # replace the DB
   cp ~/.lazyos/backups/lazyos-YYYYMMDD.db "$LAZYOS_DB_PATH"
   # integrity check
   sqlite3 "$LAZYOS_DB_PATH" "PRAGMA integrity_check;"
   # start the service
   launchctl load ~/Library/LaunchAgents/com.lazyos.server.plist
   ```
   The result is recorded in `docs/runbooks/restore-drill-log.md` (TBD).

5. **Off-site backup:** the snapshot is additionally replicated via `rsync` or
   `rclone` to an off-site store (provider: TBD, e.g. Backblaze B2 or a Hetzner
   Storage Box). Configuration in `~/.lazyos/backup-config.yaml`.

## Consequences

**Positive:**
- Data-loss risk capped at a maximum of 24 hours.
- SQLite `VACUUM INTO` / `.backup` is atomic — no partially-corrupt backup.
- The restore drill is documented and in muscle memory.
- OSS-friendly: the LaunchAgent template and systemd timer ship as templates;
  any fresh install can enable backups immediately.

**Negative / accepted:**
- The backup script and the LaunchAgent/systemd units are not yet implemented.
  Status: **open**.
- The off-site provider is not yet chosen.
- No incremental backup — the whole DB file is copied daily. Acceptable for V1;
  WAL-based incremental backup is a later concern.

**Open items:**
- `systemd/lazyos-db-backup.plist.template` and
  `systemd-units/lazyos-db-backup.{timer,service}` still need to be created.
- The off-site provider decision is pending.
- The restore-drill log template is missing.

**Sources:**
- `docs/rollback.md` (existing rollback documentation as a model).
- Local runbook notes.
