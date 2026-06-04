"use client";

/**
 * /lab Workspace-Filter (MVP, 2026-05-01).
 *
 * Client-Component, schreibt `?workspace=` in die URL. Der Server liest
 * den Parameter dann via `searchParams` und filtert die Real-Use-Counts.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

const OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Alle Workspaces" },
  { value: "demo-fitness", label: "Demo Fitness Fitness" },
  { value: "demo-client", label: "Demo PV" },
  { value: "lazyos", label: "lazyOS" },
];

export interface WorkspaceFilterProps {
  selected: string;
}

export function WorkspaceFilter({
  selected,
}: WorkspaceFilterProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const params = new URLSearchParams(searchParams.toString());
      const value = e.target.value;
      if (value === "") {
        params.delete("workspace");
      } else {
        params.set("workspace", value);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--font-display)",
        fontSize: 13,
        color: "var(--fg-muted, #999)",
      }}
    >
      Workspace
      <select
        value={selected}
        onChange={onChange}
        style={{
          padding: "6px 12px",
          background: "var(--sheet-2)",
          color: "var(--fg, #fff)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          fontFamily: "var(--font-display)",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
