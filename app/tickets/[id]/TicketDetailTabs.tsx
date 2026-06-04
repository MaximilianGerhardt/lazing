"use client";

/**
 * Tab-Container fuer Ticket-Detail (Sprint 2 · 7I).
 *
 * Zwei Tabs: Timeline | Work Products. Der aktive Tab wird im URL-Hash
 * persistiert (`#products`), damit Deep-Links den richtigen Tab oeffnen.
 *
 * Bewusste Designentscheidung: `timelineSlot` wird als pre-rendered
 * ReactNode hereingereicht. Das erlaubt dem Server, die bestehende
 * <TicketTimeline/>-Server-Component weiter zu nutzen, ohne sie in eine
 * Client-Grenze zu zwingen.
 */

import { useEffect, useState, type ReactNode } from "react";

import type { WorkProduct } from "@/lib/work-products/schema";

import { WorkProductsTab } from "./WorkProductsTab";

interface Props {
  ticketId: string;
  timelineCount: number;
  workProductsCount: number;
  commentCount: number;
  threadSlot: ReactNode;
  replySlot: ReactNode;
  timelineSlot: ReactNode;
  workProducts: WorkProduct[];
}

type TabKey = "thread" | "timeline" | "products";

export function TicketDetailTabs({
  ticketId,
  timelineCount,
  workProductsCount,
  commentCount,
  threadSlot,
  replySlot,
  timelineSlot,
  workProducts,
}: Props) {
  const [active, setActive] = useState<TabKey>("thread");

  // Hash-based deep link. Safe because hash is read client-side only.
  useEffect(() => {
    const applyFromHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (hash === "products" || hash.startsWith("wp-")) {
        setActive("products");
      } else if (hash === "timeline") {
        setActive("timeline");
      } else if (hash === "thread" || hash === "") {
        setActive("thread");
      }
    };
    applyFromHash();
    window.addEventListener("hashchange", applyFromHash);
    return () => window.removeEventListener("hashchange", applyFromHash);
  }, []);

  const onTabClick = (key: TabKey) => {
    setActive(key);
    if (typeof window !== "undefined") {
      const nextHash = key === "thread" ? "" : `#${key}`;
      const base = window.location.pathname + window.location.search;
      window.history.replaceState(null, "", `${base}${nextHash}`);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="Ticket-Details"
        className="flex items-center gap-1 border-b border-[color:var(--line)]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <TabButton
          active={active === "thread"}
          onClick={() => onTabClick("thread")}
          controls="tab-panel-thread"
        >
          Diskussion
          <span className="ml-1.5 text-[10px] text-[color:var(--ink-3)]">
            {commentCount}
          </span>
        </TabButton>
        <TabButton
          active={active === "products"}
          onClick={() => onTabClick("products")}
          controls="tab-panel-products"
        >
          Work Products
          <span className="ml-1.5 text-[10px] text-[color:var(--ink-3)]">
            {workProductsCount}
          </span>
        </TabButton>
        <TabButton
          active={active === "timeline"}
          onClick={() => onTabClick("timeline")}
          controls="tab-panel-timeline"
        >
          Timeline
          <span className="ml-1.5 text-[10px] text-[color:var(--ink-3)]">
            {timelineCount}
          </span>
        </TabButton>
      </div>

      <div
        id="tab-panel-thread"
        role="tabpanel"
        hidden={active !== "thread"}
        className="pt-2"
      >
        {threadSlot}
        {replySlot}
      </div>

      <div
        id="tab-panel-products"
        role="tabpanel"
        hidden={active !== "products"}
        className="pt-2"
      >
        <WorkProductsTab
          ticketId={ticketId}
          initialProducts={workProducts}
        />
      </div>

      <div
        id="tab-panel-timeline"
        role="tabpanel"
        hidden={active !== "timeline"}
        className="pt-2"
      >
        {timelineSlot}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  controls,
  children,
}: {
  active: boolean;
  onClick: () => void;
  controls: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className="relative px-3 py-2 text-[11px] uppercase tracking-[0.08em] transition"
      style={{
        color: active ? "var(--ink)" : "var(--ink-3)",
      }}
    >
      {children}
      <span
        aria-hidden
        className="absolute inset-x-0 -bottom-px h-px"
        style={{
          background: active ? "var(--ink)" : "transparent",
        }}
      />
    </button>
  );
}
