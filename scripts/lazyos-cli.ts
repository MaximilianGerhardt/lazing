#!/usr/bin/env -S tsx
/**
 * lazyos-cli — agent-side command-line interface for lazyOS.
 *
 * Context
 * -------
 * lazyOS spawns a Claude-Code CLI session per workspace (see
 * server/workspace-session.ts). That session has the standard
 * Read/Write/Edit/Bash toolkit but knows nothing about tickets,
 * heartbeat, routines, or push — those are lazyOS concepts, not
 * filesystem primitives.
 *
 * This CLI bridges the gap. It is a thin wrapper over the lazyOS
 * HTTP API:
 *
 *   lazyos-cli ticket create <workspace> "<title>" [--body=...] [--priority=P1]
 *   lazyos-cli ticket list [--workspace=...] [--status=open|done|danger|wait]
 *   lazyos-cli ticket update <id> [--status=...] [--body=...]
 *   lazyos-cli ticket get <id>
 *   lazyos-cli ticket timeline <id>
 *   lazyos-cli workspace list
 *   lazyos-cli workspace get <id>
 *   lazyos-cli heartbeat status
 *   lazyos-cli routine list
 *   lazyos-cli routine trigger <id>
 *   lazyos-cli push send "<title>" "<body>" [--url=/path]
 *
 * Auth
 * ----
 * Reads the bearer token from (in order):
 *   1. $LAZYOS_CLI_KEY  (preferred)
 *   2. $LAZYOS_CHAT_KEY (fallback — same key the agent-server uses)
 *   3. `~/.lazyos/agent.env` — parses KEY=VALUE lines
 *
 * Target URL: $LAZYOS_BASE_URL, defaults to http://127.0.0.1:4200.
 *
 * Output
 * ------
 * All commands print JSON to stdout. Errors go to stderr with a non-
 * zero exit code. This is deliberate so Claude-Code can `Bash -> jq`
 * the output for follow-up reasoning.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface Config {
  baseUrl: string;
  bearer: string;
}

const ENV_FILE = nodePath.join(os.homedir(), ".lazyos", "agent.env");

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadConfig(): Config {
  const fileEnv = loadEnvFile(ENV_FILE);
  const bearer =
    process.env.LAZYOS_CLI_KEY ||
    process.env.LAZYOS_CHAT_KEY ||
    fileEnv.LAZYOS_CLI_KEY ||
    fileEnv.LAZYOS_CHAT_KEY ||
    "";
  if (!bearer) {
    die(
      "no_bearer_token",
      `Set LAZYOS_CLI_KEY or LAZYOS_CHAT_KEY in env, or place it in ${ENV_FILE}.`,
    );
  }
  const baseUrl =
    process.env.LAZYOS_BASE_URL ||
    fileEnv.LAZYOS_BASE_URL ||
    "http://127.0.0.1:4200";
  return { baseUrl: baseUrl.replace(/\/+$/, ""), bearer };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

async function request<T = unknown>(
  cfg: Config,
  opts: RequestOpts,
): Promise<T> {
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&")
    : "";
  const url = `${cfg.baseUrl}${opts.path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.bearer}`,
    accept: "application/json",
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
    });
  } catch (err) {
    die(
      "network_error",
      `${opts.method ?? "GET"} ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave as string — likely an error page from upstream.
      parsed = { raw: text.slice(0, 500) };
    }
  } else {
    parsed = {};
  }
  if (!res.ok) {
    die(
      `http_${res.status}`,
      `${opts.method ?? "GET"} ${opts.path} failed: ${typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed)}`,
    );
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        // `--flag` with no value → boolean "true"
        flags[arg.slice(2)] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function die(code: string, message: string): never {
  process.stderr.write(
    JSON.stringify({ ok: false, error: code, message }) + "\n",
  );
  process.exit(1);
}

function usage(): never {
  process.stderr.write(
    [
      "lazyos-cli — agent-side CLI for lazyOS",
      "",
      "Usage:",
      '  lazyos-cli ticket create <workspace> "<title>" [--body=...] [--priority=P1] [--due=ISO] [--tags=a,b]',
      "  lazyos-cli ticket list [--workspace=...] [--status=open|done|danger|wait|all] [--query=...] [--limit=50]",
      "  lazyos-cli ticket get <id>",
      "  lazyos-cli ticket update <id> [--status=...] [--body=...] [--priority=...] [--title=...]",
      "  lazyos-cli ticket close <id>",
      "  lazyos-cli ticket timeline <id>",
      "  lazyos-cli workspace list",
      "  lazyos-cli workspace get <id>",
      "  lazyos-cli heartbeat status",
      "  lazyos-cli routine list",
      "  lazyos-cli routine trigger <id>",
      '  lazyos-cli push send "<title>" "<body>" [--url=/path] [--tag=...]',
      "  lazyos-cli cloud list <workspace> [--folder=<id>] [--limit=200]",
      "  lazyos-cli cloud stats <workspace>",
      "  lazyos-cli cloud upload <workspace> <file-path> [--folder=<id>] [--filename=<n>] [--mime=<m>]",
      "  lazyos-cli cloud generate <workspace> --md-file=<path> [--title=<s>] [--folder=<id>]   # Markdown→PDF",
      "  lazyos-cli cloud generate <workspace> --xlsx-file=<json> [--title=<s>] [--folder=<id>] # JSON→XLSX (Excel)",
      "  lazyos-cli cloud generate <workspace> --docx-file=<md>   [--title=<s>] [--folder=<id>] # Markdown→DOCX (Word)",
      "  lazyos-cli cloud generate <workspace> --pptx-file=<json> [--title=<s>] [--folder=<id>] # JSON→PPTX (PowerPoint)",
      "  lazyos-cli cloud generate <workspace> --html-file=<html> [--landscape] [--title=<s>]    # HTML→PDF (Design-Deck, schöner als pptx)",
      "  lazyos-cli cloud delete <artifact-id>",
      "  lazyos-cli system restart [--services=agent,web] [--reason=...]",
      "  lazyos-cli system status",
      "",
      "Env:",
      "  LAZYOS_CLI_KEY   bearer token (preferred)",
      "  LAZYOS_CHAT_KEY  bearer token (fallback)",
      "  LAZYOS_BASE_URL  defaults to http://127.0.0.1:4200",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseTagList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

async function cmdTicket(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "create": {
      const workspaceId = args.positional[1];
      const title = args.positional[2];
      if (!workspaceId || !title) {
        die(
          "missing_args",
          'ticket create requires: <workspace> "<title>"',
        );
      }
      const body: Record<string, unknown> = {
        workspaceId,
        title,
        actor: "agent:lazyos-cli",
      };
      if (args.flags.body) body.body = args.flags.body;
      if (args.flags.priority) body.prio = args.flags.priority;
      if (args.flags.prio) body.prio = args.flags.prio;
      if (args.flags.due) body.due = args.flags.due;
      if (args.flags.assignee) body.assignee = args.flags.assignee;
      if (args.flags.status) body.status = args.flags.status;
      const tags = parseTagList(args.flags.tags);
      if (tags) body.tags = tags;
      // Handoff-Punkt 5: Session-Context-Tracking. Wenn vom workspace-
      // session gespawnt, ist LAZYOS_SESSION_ID gesetzt.
      const sessionId =
        args.flags.sessionId ?? process.env.LAZYOS_SESSION_ID ?? null;
      if (sessionId) body.sessionId = sessionId;
      const result = await request(cfg, {
        method: "POST",
        path: "/api/tickets",
        body,
      });
      printJson(result);
      return;
    }
    case "list": {
      const result = await request(cfg, {
        method: "GET",
        path: "/api/tickets",
        query: {
          workspaceId: args.flags.workspace ?? args.flags.workspaceId,
          status: args.flags.status,
          query: args.flags.query,
          limit: args.flags.limit,
          offset: args.flags.offset,
        },
      });
      printJson(result);
      return;
    }
    case "get": {
      const id = args.positional[1];
      if (!id) die("missing_args", "ticket get requires: <id>");
      const result = await request(cfg, {
        method: "GET",
        path: `/api/tickets/${encodeURIComponent(id)}`,
      });
      printJson(result);
      return;
    }
    case "update": {
      const id = args.positional[1];
      if (!id) die("missing_args", "ticket update requires: <id>");
      const body: Record<string, unknown> = { actor: "agent:lazyos-cli" };
      if (args.flags.title) body.title = args.flags.title;
      if (args.flags.body) body.body = args.flags.body;
      if (args.flags.status) body.status = args.flags.status;
      if (args.flags.priority) body.prio = args.flags.priority;
      if (args.flags.prio) body.prio = args.flags.prio;
      if (args.flags.due) body.due = args.flags.due;
      if (args.flags.assignee) body.assignee = args.flags.assignee;
      if (args.flags.workflowState)
        body.workflowState = args.flags.workflowState;
      const tags = parseTagList(args.flags.tags);
      if (tags) body.tags = tags;
      // Handoff-Punkt 5: session-tracking (kein update-only-field check —
      // sessionId alleine soll kein Noop-Update sein, drum unten getestet
      // BEVOR sessionId hinzugefügt wird).
      if (Object.keys(body).length === 1) {
        die("missing_args", "ticket update requires at least one field to change");
      }
      const sessionId =
        args.flags.sessionId ?? process.env.LAZYOS_SESSION_ID ?? null;
      if (sessionId) body.sessionId = sessionId;
      const result = await request(cfg, {
        method: "PATCH",
        path: `/api/tickets/${encodeURIComponent(id)}`,
        body,
      });
      printJson(result);
      return;
    }
    case "close": {
      const id = args.positional[1];
      if (!id) die("missing_args", "ticket close requires: <id>");
      const result = await request(cfg, {
        method: "DELETE",
        path: `/api/tickets/${encodeURIComponent(id)}`,
      });
      printJson(result);
      return;
    }
    case "timeline": {
      const id = args.positional[1];
      if (!id) die("missing_args", "ticket timeline requires: <id>");
      const result = await request(cfg, {
        method: "GET",
        path: `/api/tickets/${encodeURIComponent(id)}/timeline`,
      });
      printJson(result);
      return;
    }
    default:
      die("unknown_subcommand", `ticket ${sub ?? "(none)"} not recognised`);
  }
}

async function cmdWorkspace(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "list": {
      const result = await request(cfg, {
        method: "GET",
        path: "/api/workspaces",
      });
      printJson(result);
      return;
    }
    case "get": {
      const id = args.positional[1];
      if (!id) die("missing_args", "workspace get requires: <id>");
      const result = await request<{ workspaces?: unknown[] }>(cfg, {
        method: "GET",
        path: "/api/workspaces",
      });
      const list = Array.isArray(result?.workspaces) ? result.workspaces : [];
      const match = list.find(
        (w) => w && typeof w === "object" && (w as { id?: string }).id === id,
      );
      if (!match) die("not_found", `workspace '${id}' not found`);
      printJson({ workspace: match });
      return;
    }
    default:
      die("unknown_subcommand", `workspace ${sub ?? "(none)"} not recognised`);
  }
}

async function cmdHeartbeat(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub !== "status") {
    die("unknown_subcommand", `heartbeat ${sub ?? "(none)"} not recognised`);
  }
  const result = await request(cfg, {
    method: "GET",
    path: "/api/heartbeat/status",
  });
  printJson(result);
}

async function cmdRoutine(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "list": {
      const result = await request(cfg, {
        method: "GET",
        path: "/api/routines",
      });
      printJson(result);
      return;
    }
    case "trigger": {
      const id = args.positional[1];
      if (!id) die("missing_args", "routine trigger requires: <id>");
      const result = await request(cfg, {
        method: "POST",
        path: `/api/routines/${encodeURIComponent(id)}/trigger`,
        body: { actor: "agent:lazyos-cli" },
      });
      printJson(result);
      return;
    }
    default:
      die("unknown_subcommand", `routine ${sub ?? "(none)"} not recognised`);
  }
}

async function cmdCloud(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "list": {
      const workspace = args.positional[1] ?? args.flags.workspace;
      if (!workspace) {
        die("missing_args", "cloud list requires: <workspace>");
      }
      const folder = args.flags.folder ?? "root";
      const limit = args.flags.limit ?? "200";
      const qs = new URLSearchParams({ workspace, folder, limit }).toString();
      const result = await request(cfg, {
        method: "GET",
        path: `/api/cloud?${qs}`,
      });
      printJson(result);
      return;
    }
    case "stats": {
      const workspace = args.positional[1] ?? args.flags.workspace;
      if (!workspace) {
        die("missing_args", "cloud stats requires: <workspace>");
      }
      const result = await request(cfg, {
        method: "GET",
        path: `/api/cloud/stats?workspace=${encodeURIComponent(workspace)}`,
      });
      printJson(result);
      return;
    }
    case "generate": {
      // Pdf-from-Markdown — der Hauptweg für Agenten, ein Berichts-PDF
      // direkt in einen Workspace zu legen + Surface-Markup für Chat.
      const workspace = args.positional[1] ?? args.flags.workspace;
      if (!workspace) {
        die("missing_args", "cloud generate requires: <workspace>");
      }
      const title =
        args.flags.title ?? `Bericht ${new Date().toISOString().slice(0, 10)}`;

      // Built-In-Skill json-to-xlsx (2026-06-03): Excel-Deliverable aus einer
      // JSON-Datei { sheets:[{name?,headers[],rows[][]}] }. --xlsx-file ist der
      // idiomatische Weg für Agenten (lokal, N2/N9-konform, kein Cloud-Sandbox).
      const xlsxFile = args.flags["xlsx-file"];
      if (xlsxFile) {
        const fs = await import("node:fs");
        let data: unknown;
        try {
          data = JSON.parse(fs.readFileSync(xlsxFile, "utf8"));
        } catch (err) {
          die("xlsx_file_unreadable", `cannot read/parse --xlsx-file=${xlsxFile}: ${(err as Error).message}`);
        }
        const xpayload: Record<string, unknown> = {
          workspace,
          type: "json-to-xlsx",
          title,
          data,
        };
        if (args.flags.folder) xpayload.folder = args.flags.folder;
        const xresult = await request(cfg, {
          method: "POST",
          path: "/api/cloud/generate",
          body: xpayload,
        });
        printJson(xresult);
        return;
      }

      // Built-In-Skill markdown-to-docx (2026-06-03): Word-Deliverable aus einer
      // Markdown-Datei. --docx-file = idiomatischer Agenten-Weg.
      const docxFile = args.flags["docx-file"];
      if (docxFile) {
        const fs = await import("node:fs");
        let md: string;
        try {
          md = fs.readFileSync(docxFile, "utf8");
        } catch (err) {
          die("docx_file_unreadable", `cannot read --docx-file=${docxFile}: ${(err as Error).message}`);
        }
        const dpayload: Record<string, unknown> = { workspace, type: "markdown-to-docx", title, markdown: md };
        if (args.flags.folder) dpayload.folder = args.flags.folder;
        printJson(await request(cfg, { method: "POST", path: "/api/cloud/generate", body: dpayload }));
        return;
      }

      // Built-In-Skill json-to-pptx (2026-06-03): PowerPoint aus JSON
      // { slides:[{title,bullets[]}], subtitle? }. --pptx-file = Agenten-Weg.
      const pptxFile = args.flags["pptx-file"];
      if (pptxFile) {
        const fs = await import("node:fs");
        let data: unknown;
        try {
          data = JSON.parse(fs.readFileSync(pptxFile, "utf8"));
        } catch (err) {
          die("pptx_file_unreadable", `cannot read/parse --pptx-file=${pptxFile}: ${(err as Error).message}`);
        }
        const ppayload: Record<string, unknown> = { workspace, type: "json-to-pptx", title, data };
        if (args.flags.folder) ppayload.folder = args.flags.folder;
        printJson(await request(cfg, { method: "POST", path: "/api/cloud/generate", body: ppayload }));
        return;
      }

      // Design-Deck-Pfad html-to-pdf (2026-06-03): gestaltetes HTML → PDF.
      // Schönere Pitches/Decks als pptx (Codex-/ImageGen2-Visuals einbettbar).
      // --landscape für Querformat (Decks).
      const htmlFile = args.flags["html-file"];
      if (htmlFile) {
        const fs = await import("node:fs");
        let html: string;
        try {
          html = fs.readFileSync(htmlFile, "utf8");
        } catch (err) {
          die("html_file_unreadable", `cannot read --html-file=${htmlFile}: ${(err as Error).message}`);
        }
        const hpayload: Record<string, unknown> = { workspace, type: "html-to-pdf", title, html };
        if (args.flags.landscape !== undefined) hpayload.landscape = true;
        if (args.flags.folder) hpayload.folder = args.flags.folder;
        printJson(await request(cfg, { method: "POST", path: "/api/cloud/generate", body: hpayload }));
        return;
      }

      // Markdown kann via --md-file=<path> ODER --md=<inline-string> kommen.
      // --md-file ist der idiomatische Weg für Agenten.
      let markdown = args.flags.md ?? "";
      const mdFile = args.flags["md-file"];
      if (mdFile) {
        const fs = await import("node:fs");
        try {
          markdown = fs.readFileSync(mdFile, "utf8");
        } catch (err) {
          die(
            "md_file_unreadable",
            `cannot read --md-file=${mdFile}: ${(err as Error).message}`,
          );
        }
      }
      if (!markdown.trim()) {
        die(
          "missing_args",
          "cloud generate requires --md=<inline> or --md-file=<path>",
        );
      }
      const payload: Record<string, unknown> = {
        workspace,
        type: "markdown-to-pdf",
        title,
        markdown,
      };
      if (args.flags.folder) payload.folder = args.flags.folder;
      if (args.flags.footer) payload.footer = args.flags.footer;
      const result = await request(cfg, {
        method: "POST",
        path: "/api/cloud/generate",
        body: payload,
      });
      printJson(result);
      return;
    }
    case "upload": {
      // Lokale Datei als Cloud-Artifact uploaden. Multipart-Form via
      // Node-fetch + FormData. Dient KI-Pipelines die ein lokal
      // erzeugtes Asset (Bild, Excel, fertiges PDF) hochladen wollen.
      const workspace = args.positional[1] ?? args.flags.workspace;
      const filePath = args.positional[2] ?? args.flags.file;
      if (!workspace || !filePath) {
        die("missing_args", "cloud upload requires: <workspace> <file-path>");
      }
      const fs = await import("node:fs");
      const path = await import("node:path");
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch (err) {
        die("file_unreadable", `cannot read ${filePath}: ${(err as Error).message}`);
      }
      const filename = args.flags.filename ?? path.basename(filePath);
      const mime = args.flags.mime ?? guessMime(filename);
      const form = new FormData();
      form.append("workspace", workspace);
      if (args.flags.folder) form.append("folder", args.flags.folder);
      form.append(
        "file",
        new Blob([new Uint8Array(buffer)], { type: mime }),
        filename,
      );
      // Direkt mit fetch (request() ist JSON-only)
      const url = `${cfg.baseUrl}/api/cloud`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.bearer}` },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        die(
          "upload_failed",
          `HTTP ${res.status}: ${(body.message as string | undefined) ?? (body.error as string | undefined) ?? "unknown"}`,
        );
      }
      printJson(body);
      return;
    }
    case "delete": {
      const id = args.positional[1];
      if (!id) die("missing_args", "cloud delete requires: <artifact-id>");
      const result = await request(cfg, {
        method: "DELETE",
        path: `/api/cloud/${encodeURIComponent(id)}`,
      });
      printJson(result);
      return;
    }
    default:
      die("unknown_subcommand", `cloud ${sub ?? "(none)"} not recognised`);
  }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function cmdPush(cfg: Config, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub !== "send") {
    die("unknown_subcommand", `push ${sub ?? "(none)"} not recognised`);
  }
  const title = args.positional[1];
  const body = args.positional[2];
  if (!title || !body) {
    die("missing_args", 'push send requires: "<title>" "<body>"');
  }
  const payload: Record<string, unknown> = { title, body };
  if (args.flags.url) payload.url = args.flags.url;
  if (args.flags.tag) payload.tag = args.flags.tag;
  const result = await request(cfg, {
    method: "POST",
    path: "/api/push/send",
    body: payload,
  });
  printJson(result);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
  }
  const topLevel = argv[0];
  const sub = parseArgs(argv.slice(1));

  // `skill`-Befehle sind reine lokale FS-Operationen (Store/Sync/Install) — KEIN
  // Bearer-Token / HTTP nötig. Vor loadConfig() abfangen, damit sie auch ohne
  // gesetzten Token laufen (OSS: Skills installieren ohne Server-Setup).
  if (topLevel === "skill") {
    await cmdSkill(sub);
    return;
  }

  const cfg = loadConfig();

  switch (topLevel) {
    case "ticket":
      await cmdTicket(cfg, sub);
      return;
    case "workspace":
      await cmdWorkspace(cfg, sub);
      return;
    case "heartbeat":
      await cmdHeartbeat(cfg, sub);
      return;
    case "routine":
      await cmdRoutine(cfg, sub);
      return;
    case "push":
      await cmdPush(cfg, sub);
      return;
    case "cloud":
      await cmdCloud(cfg, sub);
      return;
    case "system":
      await cmdSystem(cfg, sub);
      return;
    case "skill":
      await cmdSkill(sub);
      return;
    default:
      die("unknown_command", `'${topLevel}' is not a lazyos-cli command`);
  }
}

// ---------------------------------------------------------------------------
// skill — Engine-übergreifende Skills (2026-06-03): list | install | sync
// ---------------------------------------------------------------------------

async function cmdSkill(sub: ReturnType<typeof parseArgs>): Promise<void> {
  const action = sub.positional[0];
  if (!action || action === "list") {
    const { listInstalledSkills } = await import("../lib/skills/store");
    const skills = listInstalledSkills();
    printJson({
      store: (await import("../lib/skills/store")).getSkillsDir(),
      count: skills.length,
      skills: skills.map((s) => ({ id: s.id, name: s.name, source: s.source ?? "built-in", description: s.description.slice(0, 120) })),
    });
    return;
  }
  if (action === "install") {
    const source = sub.positional[1] ?? sub.flags.source;
    if (!source) {
      die("missing_args", "lazyos-cli skill install <pfad|owner/repo[/unterpfad]|git-url>");
    }
    const { installSkill, SkillInstallError } = await import("../lib/skills/install");
    try {
      const res = await installSkill(source);
      printJson({ installed: res.installed, synced: res.sync.map((s) => ({ engine: s.engine, linked: s.linked, skipped: s.skipped })) });
    } catch (err) {
      die(err instanceof SkillInstallError ? "skill_install_failed" : "error", err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (action === "sync") {
    const { syncSkillsToEngines } = await import("../lib/skills/sync");
    printJson({ synced: syncSkillsToEngines().map((s) => ({ engine: s.engine, dir: s.dir, linked: s.linked, skipped: s.skipped })) });
    return;
  }
  if (action === "validate") {
    const id = sub.positional[1] ?? sub.flags.id;
    if (!id) die("missing_args", "lazyos-cli skill validate <id|pfad>");
    const { validateSkill } = await import("../lib/skills/validate");
    printJson(validateSkill(id));
    return;
  }
  if (action === "bench") {
    const evalPath = sub.positional[1] ?? sub.flags["eval-set"];
    if (!evalPath) {
      die("missing_args", "lazyos-cli skill bench <eval-set.json> [--mode=claude-cli|codex-cli|ollama]");
    }
    const fs = await import("node:fs");
    let evalSet: unknown;
    try {
      evalSet = JSON.parse(fs.readFileSync(evalPath, "utf8"));
    } catch (err) {
      die("eval_set_unreadable", `cannot read/parse ${evalPath}: ${(err as Error).message}`);
    }
    const mode = (sub.flags.mode as "claude-cli" | "codex-cli" | "ollama") ?? "claude-cli";
    const { runBenchmark } = await import("../lib/skills/benchmark");
    printJson(await runBenchmark(evalSet as Parameters<typeof runBenchmark>[0], { mode }));
    return;
  }
  die("unknown_action", "lazyos-cli skill <list|install|sync|validate|bench>");
}

// ---------------------------------------------------------------------------
// system — Phase AR (2026-04-28): Service-Restart mit Audit-Log
// ---------------------------------------------------------------------------

async function cmdSystem(
  cfg: ReturnType<typeof loadConfig>,
  sub: ReturnType<typeof parseArgs>,
): Promise<void> {
  const action = sub.positional[0];
  if (!action) {
    die("missing_args", "lazyos-cli system <restart|status>");
  }
  if (action === "restart") {
    const services = sub.flags.services
      ? sub.flags.services.split(",").map((s) => s.trim())
      : ["agent"];
    const reason = sub.flags.reason ?? "via lazyos-cli";
    const url = `${cfg.baseUrl}/api/system/restart-services`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.bearer}`,
      },
      body: JSON.stringify({ services, reason }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      die("restart_failed", JSON.stringify(body));
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  if (action === "status") {
    const url = `${cfg.baseUrl}/api/health`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.bearer}` },
    });
    const body = await res.text();
    process.stdout.write(body + "\n");
    return;
  }
  die("unknown_action", `lazyos-cli system: '${action}' nicht erkannt. Verwende: restart | status`);
}

main().catch((err) => {
  die(
    "unhandled_error",
    err instanceof Error ? err.message : String(err),
  );
});
