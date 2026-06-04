"use client";

/**
 * Work-Products Tab (Sprint 2 · 7I).
 *
 * Zeigt alle Artefakte eines Tickets, sortiert nach createdAt DESC.
 * Inline-Viewer pro Type:
 *   - markdown   → einfaches Heading/Paragraph-Rendering (kein npm-react-markdown,
 *                  um keine neue Dependency einzuziehen — MVP-tauglich).
 *   - url        → clickable Link + Host-Snippet
 *   - json       → pretty-print
 *   - code_diff  → monospace pre
 *   - email      → From/To/Subject/Body-Split heuristisch
 *   - pdf        → iframe (nur wenn Pfad unter ~/.lazyos/...)
 *
 * Quick-Add: inline-Drawer mit Type, Title, Content.
 *
 * Der komplette Fetch/Mutation-Flow laeuft ueber das /api/tickets/:id/products
 * Endpoint. Keine direkten DB-Zugriffe aus der Client-Komponente.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  WorkProduct,
  WorkProductStatus,
  WorkProductType,
} from "@/lib/work-products/schema";

interface Props {
  ticketId: string;
  /** Server-seitiger initial-Load, damit der Tab ohne Network-Round-trip
   *  den ersten Frame rendert. Client refetched bei Mutations. */
  initialProducts: WorkProduct[];
}

const TYPE_LABELS: Record<WorkProductType, string> = {
  markdown: "Markdown",
  url: "Link",
  code_diff: "Code-Diff",
  pdf: "PDF",
  email: "E-Mail",
  json: "JSON",
};

const TYPE_ICONS: Record<WorkProductType, ReactNode> = {
  markdown: "M",
  url: "↗",
  code_diff: "⟨/⟩",
  pdf: "◰",
  email: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  ),
  json: "{}",
};

const STATUS_STYLES: Record<WorkProductStatus, string> = {
  draft: "bg-white/10 text-[color:var(--ink-2)]",
  final: "bg-[color:var(--a-clientb)]/15 text-[color:var(--a-clientb)]",
  superseded: "bg-white/5 text-[color:var(--ink-3)] line-through",
};

export function WorkProductsTab({ ticketId, initialProducts }: Props) {
  const [products, setProducts] = useState<WorkProduct[]>(initialProducts);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/products`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`list_failed: ${res.status}`);
      const data = (await res.json()) as { products: WorkProduct[] };
      setProducts(data.products);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown_error");
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  return (
    <section
      className="relative flex flex-col gap-3"
      aria-label="Work Products"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[color:var(--ink)]">
            Work Products
          </h2>
          <p className="text-xs text-[color:var(--ink-3)]">
            Artefakte, die zu diesem Ticket gehoeren — Agent-Output, Uploads,
            Reports.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="rounded-full border border-[color:var(--line-2)] bg-[color:var(--card-2)] px-3 py-1.5 text-xs font-medium text-[color:var(--ink)] transition hover:bg-[color:var(--card-3)]"
        >
          + Add
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-[color:var(--a-danger)]/40 bg-[color:var(--a-danger)]/10 px-3 py-2 text-xs text-[color:var(--a-danger)]">
          {error}
        </div>
      ) : null}

      {loading && products.length === 0 ? (
        <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--card)] px-4 py-6 text-center text-xs text-[color:var(--ink-3)]">
          Lade …
        </div>
      ) : products.length === 0 ? (
        <EmptyState onAdd={() => setDrawerOpen(true)} />
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {products.map((p) => (
            <li key={p.id} id={`wp-${p.id}`}>
              <WorkProductCard
                product={p}
                expanded={expandedId === p.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === p.id ? null : p.id))
                }
                onChange={refresh}
                ticketId={ticketId}
              />
            </li>
          ))}
        </ul>
      )}

      {drawerOpen ? (
        <AddDrawer
          ticketId={ticketId}
          onClose={() => setDrawerOpen(false)}
          onCreated={() => {
            setDrawerOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {/* When the tab first mounts and initialProducts was empty we
          still refresh once (client-only tab-switch, e.g. after an add
          in another window). */}
      <MountRefresh
        run={() => {
          if (initialProducts.length === 0 && !loading && !drawerOpen) {
            void refresh();
          }
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  product: WorkProduct;
  expanded: boolean;
  onToggle: () => void;
  onChange: () => void;
  ticketId: string;
}

function WorkProductCard({
  product,
  expanded,
  onToggle,
  onChange,
  ticketId,
}: CardProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mutateStatus = async (next: WorkProductStatus) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/products/${encodeURIComponent(product.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: next }),
        },
      );
      if (!res.ok) throw new Error(`patch_failed: ${res.status}`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setBusy(false);
    }
  };

  const supersede = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/products/${encodeURIComponent(product.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`supersede_failed: ${res.status}`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="overflow-hidden rounded-lg border border-[color:var(--line)] bg-[color:var(--card)]"
      aria-expanded={expanded}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[color:var(--card-2)]"
      >
        <span
          className="grid h-8 w-8 place-items-center rounded-md bg-[color:var(--card-2)] font-mono text-xs text-[color:var(--ink-2)]"
          aria-hidden
        >
          {TYPE_ICONS[product.type]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-[color:var(--ink)]">
            {product.title}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--ink-3)]">
            <span>{TYPE_LABELS[product.type]}</span>
            <span aria-hidden>·</span>
            <span>{formatDate(product.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{formatBytes(product.bytes)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">by {product.createdBy}</span>
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLES[product.status]}`}
        >
          {product.status}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-[color:var(--line)] bg-[color:var(--sheet-2)] px-4 py-3">
          <WorkProductViewer product={product} />

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[color:var(--line)] pt-3">
            {product.status === "draft" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => mutateStatus("final")}
                className="rounded-md border border-[color:var(--line-2)] bg-[color:var(--card)] px-3 py-1 text-xs text-[color:var(--ink)] transition hover:bg-[color:var(--card-2)] disabled:opacity-50"
              >
                Mark final
              </button>
            ) : null}
            {product.status === "final" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => mutateStatus("draft")}
                className="rounded-md border border-[color:var(--line-2)] bg-[color:var(--card)] px-3 py-1 text-xs text-[color:var(--ink-2)] transition hover:bg-[color:var(--card-2)] disabled:opacity-50"
              >
                Back to draft
              </button>
            ) : null}
            {product.status !== "superseded" ? (
              <button
                type="button"
                disabled={busy}
                onClick={supersede}
                className="rounded-md border border-[color:var(--a-danger)]/40 bg-[color:var(--a-danger)]/10 px-3 py-1 text-xs text-[color:var(--a-danger)] transition hover:bg-[color:var(--a-danger)]/20 disabled:opacity-50"
              >
                Supersede
              </button>
            ) : null}
            {err ? (
              <span className="text-xs text-[color:var(--a-danger)]">{err}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function WorkProductViewer({ product }: { product: WorkProduct }) {
  if (product.type === "markdown") {
    return <MarkdownViewer source={product.content} />;
  }
  if (product.type === "url") {
    return <UrlViewer href={product.content} />;
  }
  if (product.type === "json") {
    return <JsonViewer source={product.content} />;
  }
  if (product.type === "code_diff") {
    return <PreViewer source={product.content} mono />;
  }
  if (product.type === "email") {
    return <EmailViewer source={product.content} />;
  }
  if (product.type === "pdf") {
    return <PdfViewer path={product.content} />;
  }
  // Fallback — unknown type rendered as pre.
  return <PreViewer source={product.content} />;
}

function MarkdownViewer({ source }: { source: string }) {
  // Minimaler MD-Renderer — Headings, Paragraphs, Code-Fences, Listen.
  // Kein externer Parser (keine XSS-Vektoren, da wir jede Zeile escapen).
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed text-[color:var(--ink)]">
      {blocks.map((b, i) => {
        if (b.type === "h1") {
          return (
            <h3 key={i} className="text-base font-semibold text-[color:var(--ink)]">
              {b.text}
            </h3>
          );
        }
        if (b.type === "h2") {
          return (
            <h4 key={i} className="text-sm font-semibold text-[color:var(--ink)]">
              {b.text}
            </h4>
          );
        }
        if (b.type === "code") {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-md border border-[color:var(--line)] bg-black/40 px-3 py-2 font-mono text-xs text-[color:var(--ink-2)]"
            >
              {b.text}
            </pre>
          );
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="ml-4 list-disc text-[color:var(--ink-2)]">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-[color:var(--ink-2)]">
            {b.text}
          </p>
        );
      })}
    </div>
  );
}

function UrlViewer({ href }: { href: string }) {
  let hostname = href;
  try {
    hostname = new URL(href).hostname;
  } catch {
    // keep raw
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="truncate text-[color:var(--a-private)] underline decoration-[color:var(--a-private)]/40 underline-offset-2 hover:decoration-[color:var(--a-private)]"
      >
        {href}
      </a>
      <span className="text-xs text-[color:var(--ink-3)]">{hostname}</span>
    </div>
  );
}

function JsonViewer({ source }: { source: string }) {
  let formatted = source;
  try {
    formatted = JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    // invalid JSON, already blocked by Zod. Defensive fallback.
  }
  return <PreViewer source={formatted} mono />;
}

function PreViewer({
  source,
  mono = false,
}: {
  source: string;
  mono?: boolean;
}) {
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--line)] bg-black/30 px-3 py-2 text-xs text-[color:var(--ink-2)] ${mono ? "font-mono" : ""}`}
    >
      {source}
    </pre>
  );
}

function EmailViewer({ source }: { source: string }) {
  // Heuristik: erste Leerzeile trennt Header von Body. Bekannte Header:
  // From:, To:, Cc:, Subject:. Alles andere bleibt im Body.
  const headerEnd = source.indexOf("\n\n");
  const headerBlock = headerEnd >= 0 ? source.slice(0, headerEnd) : "";
  const body = headerEnd >= 0 ? source.slice(headerEnd + 2) : source;

  const headers: Record<string, string> = {};
  if (headerBlock) {
    for (const line of headerBlock.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (["from", "to", "cc", "subject"].includes(key)) {
          headers[key] = val;
        }
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {Object.keys(headers).length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2 text-xs">
          {(["from", "to", "cc", "subject"] as const).map((k) =>
            headers[k] ? (
              <div key={k} className="contents">
                <dt className="font-medium uppercase tracking-wide text-[color:var(--ink-3)]">
                  {k}
                </dt>
                <dd className="truncate text-[color:var(--ink)]">
                  {headers[k]}
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
      <PreViewer source={body} />
    </div>
  );
}

function PdfViewer({ path }: { path: string }) {
  // PDFs leben unter ~/.lazyos/work-products/<id>.pdf. Wir
  // erwarten, dass eine spaetere Route `/api/work-products/file?path=...`
  // oder aehnlich das Binary serviert. Fuer MVP zeigen wir den Pfad.
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2 font-mono text-xs text-[color:var(--ink-2)]">
        {path}
      </div>
      <p className="text-xs text-[color:var(--ink-3)]">
        PDF-Preview folgt in Sprint 3 (iframe auf signiertem Download-
        Endpoint). Pfad ist relativ zu <code>~/.lazyos/work-products/</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-Drawer
// ---------------------------------------------------------------------------

interface AddDrawerProps {
  ticketId: string;
  onClose: () => void;
  onCreated: () => void;
}

function AddDrawer({ ticketId, onClose, onCreated }: AddDrawerProps) {
  const [type, setType] = useState<WorkProductType>("markdown");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/products`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type, title: title.trim(), content }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: unknown[];
        };
        throw new Error(data.error ?? `create_failed_${res.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add work product"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col gap-4 rounded-t-2xl border border-[color:var(--line-2)] bg-[color:var(--sheet-2)] p-5 sm:rounded-2xl"
      >
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[color:var(--ink)]">
            Neues Work-Product
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-[color:var(--ink-3)] hover:bg-[color:var(--card)]"
            aria-label="Close"
          >
            esc
          </button>
        </header>

        <label className="flex flex-col gap-1 text-xs text-[color:var(--ink-2)]">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as WorkProductType)}
            className="rounded-md border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2 text-sm text-[color:var(--ink)] focus:border-[color:var(--line-2)] focus:outline-none"
          >
            {(Object.keys(TYPE_LABELS) as WorkProductType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[color:var(--ink-2)]">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            className="rounded-md border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2 text-sm text-[color:var(--ink)] focus:border-[color:var(--line-2)] focus:outline-none"
            placeholder="z.B. Analyse-Bericht v2"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[color:var(--ink-2)]">
          {contentHint(type)}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            maxLength={500_000}
            rows={8}
            className="min-h-[140px] resize-y rounded-md border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2 font-mono text-xs text-[color:var(--ink)] focus:border-[color:var(--line-2)] focus:outline-none"
            placeholder={contentPlaceholder(type)}
          />
        </label>

        {err ? (
          <p className="text-xs text-[color:var(--a-danger)]">{err}</p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[color:var(--line)] px-3 py-1.5 text-xs text-[color:var(--ink-2)] hover:bg-[color:var(--card)]"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim() || !content}
            className="rounded-md bg-[color:var(--primary)] px-4 py-1.5 text-xs font-medium text-black disabled:opacity-40"
          >
            {busy ? "Speichere…" : "Hinzufuegen"}
          </button>
        </div>
      </form>
    </div>
  );
}

function contentHint(t: WorkProductType): string {
  switch (t) {
    case "markdown":
      return "Markdown-Content";
    case "url":
      return "URL (http/https)";
    case "json":
      return "JSON";
    case "email":
      return "E-Mail (From:/To:/Subject: im Header, Leerzeile, dann Body)";
    case "code_diff":
      return "Unified-Diff";
    case "pdf":
      return "PDF-Pfad (relativ zu ~/.lazyos/work-products/)";
    default:
      return "Content";
  }
}

function contentPlaceholder(t: WorkProductType): string {
  switch (t) {
    case "markdown":
      return "# Title\n\nParagraph…";
    case "url":
      return "https://…";
    case "json":
      return '{\n  "key": "value"\n}';
    case "email":
      return "From: team@…\nTo: max@…\nSubject: …\n\nBody…";
    case "code_diff":
      return "--- a/file\n+++ b/file\n@@ -1,3 +1,3 @@";
    case "pdf":
      return "reports/2026-04-24-status.pdf";
    default:
      return "";
  }
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--line-2)] bg-[color:var(--card)] px-6 py-10 text-center">
      <p className="text-sm text-[color:var(--ink-2)]">
        Noch keine Work-Products
      </p>
      <p className="mt-1 text-xs text-[color:var(--ink-3)]">
        Haenge Artefakte an, die zu diesem Ticket gehoeren — Markdown,
        Links, Diffs, E-Mail-Drafts.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 rounded-full border border-[color:var(--line-2)] bg-[color:var(--card-2)] px-4 py-1.5 text-xs font-medium text-[color:var(--ink)] transition hover:bg-[color:var(--card-3)]"
      >
        + Erstes Work-Product
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tiny invisible component that runs an effect once after mount. We use
 * it to conditionally re-fetch when the tab is first shown and the server
 * delivered an empty list — which could mean "really empty" OR "just
 * stale projection". Cheap enough.
 */
function MountRefresh({ run }: { run: () => void }) {
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number): string {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return "gerade eben";
    if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} min`;
    if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} h`;
    return d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

// --- Mini-Markdown-Parser ---------------------------------------------------

type MdBlock =
  | { type: "h1" | "h2" | "p"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; items: string[] };

function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Code-Fence
    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      out.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    // Heading
    if (line.startsWith("# ")) {
      out.push({ type: "h1", text: line.slice(2).trim() });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push({ type: "h2", text: line.slice(3).trim() });
      i++;
      continue;
    }
    // List
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, "").trim());
        i++;
      }
      out.push({ type: "list", items });
      continue;
    }
    // Empty separator
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph — greedy bis Leerzeile.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").startsWith("# ") &&
      !(lines[i] ?? "").startsWith("## ") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trimStart().startsWith("```")
    ) {
      buf.push(lines[i] ?? "");
      i++;
    }
    out.push({ type: "p", text: buf.join(" ").trim() });
  }
  return out;
}
