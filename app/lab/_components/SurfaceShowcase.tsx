"use client";

/**
 * /lab Tab-Switcher (MVP, 2026-05-01).
 *
 * Apple-Pure-Pill-Group: 5 Tabs, URL-Param `?tab=` als Single Source of Truth.
 * Selected-State via `?tab=`-Match. Klick triggert client-seitige Navigation
 * via `router.replace` damit kein voller Reload entsteht und kein
 * Server-Re-Fetch-Cost entsteht.
 *
 * Refactor-Tab und SpringStack-Toggle kommen in Welle 3 — bis dahin zeigt
 * der Refactor-Tab einen Placeholder.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, type ReactNode } from "react";

export type LabTabId =
  | "live"
  | "refactored"
  | "real"
  | "diff"
  | "tokens"
  | "spring";

export interface LabTab {
  id: LabTabId;
  label: string;
}

export const LAB_TABS: ReadonlyArray<LabTab> = [
  { id: "live", label: "Live" },
  { id: "refactored", label: "Refactored" },
  { id: "real", label: "Real-Use" },
  { id: "diff", label: "Diff" },
  { id: "tokens", label: "Tokens" },
  { id: "spring", label: "Spring-Compare" },
];

export function isLabTabId(value: string | null | undefined): value is LabTabId {
  return (
    value === "live" ||
    value === "refactored" ||
    value === "real" ||
    value === "diff" ||
    value === "tokens" ||
    value === "spring"
  );
}

export interface SurfaceShowcaseProps {
  activeTab: LabTabId;
  /**
   * Render-Map: wir lassen den Server jeden Tab pre-rendern und reichen
   * sie als Children durch. So bleibt das Switching client-side billig
   * ohne Re-Fetch (Tabs sind nur Show/Hide). Foundation-MVP, kann später
   * auf code-split per Tab umgestellt werden.
   */
  panels: Record<LabTabId, ReactNode>;
}

export function SurfaceShowcase({
  activeTab,
  panels,
}: SurfaceShowcaseProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onTabClick = useCallback(
    (tabId: LabTabId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tabId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div
        role="tablist"
        aria-label="Showcase-Tabs"
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          background: "var(--sheet-2)",
          border: "1px solid var(--line)",
          borderRadius: 999,
          alignSelf: "flex-start",
          maxWidth: "100%",
          overflowX: "auto",
        }}
      >
        {LAB_TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabClick(tab.id)}
              style={{
                padding: "8px 16px",
                borderRadius: 999,
                border: "none",
                fontFamily: "var(--font-display)",
                fontSize: 14,
                fontWeight: isActive ? 600 : 500,
                background: isActive ? "var(--sheet-3)" : "transparent",
                color: isActive ? "var(--fg, #fff)" : "var(--fg-muted, #999)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background 120ms ease",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {panels[activeTab]}
      </div>
    </div>
  );
}
