"use client";

/**
 * /lab tab switcher (MVP, 2026-05-01).
 *
 * Apple-pure pill group: 5 tabs, URL param `?tab=` as the single source of truth.
 * Selected state via `?tab=` match. Click triggers client-side navigation
 * via `router.replace` so that no full reload occurs and no
 * server re-fetch cost arises.
 *
 * The refactor tab and SpringStack toggle arrive in wave 3 — until then the
 * refactor tab shows a placeholder.
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
   * Render map: we let the server pre-render each tab and pass them
   * through as children. This keeps switching cheap on the client
   * without re-fetch (tabs are just show/hide). Foundation MVP, can later
   * be switched to code-split per tab.
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
