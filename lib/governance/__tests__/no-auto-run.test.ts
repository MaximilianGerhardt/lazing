/**
 * Lane G Governance — no-auto-run.ts Tests.
 *
 * canAutoRun ist eine PURE Funktion (kein DB-Setup nötig). Wir testen die
 * Gate-Matrix-Logik direkt.
 */

import { describe, expect, it } from "vitest";

import {
  canAutoRun,
  NO_AUTO_RUN_RULES,
  type ActionKind,
} from "@/lib/governance/no-auto-run";

describe("Lane G · no-auto-run.ts", () => {
  it("connector-invoke-live: deny without consent + human-approval", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "connector-invoke-live",
      dataSource: "whatsapp",
      hasConsent: false,
      humanApproved: false,
    });
    expect(r.ok).toBe(false);
    expect(r.missingGate).toBe("consent:read-derive-act");
  });

  it("connector-invoke-live: deny without human-approval (consent only)", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "connector-invoke-live",
      dataSource: "whatsapp",
      hasConsent: true,
      humanApproved: false,
    });
    expect(r.ok).toBe(false);
    expect(r.missingGate).toBe("human-approval");
  });

  it("connector-invoke-live: allow with consent + human-approval", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "connector-invoke-live",
      dataSource: "whatsapp",
      hasConsent: true,
      humanApproved: true,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("Caller MUSS writeGovernanceAudit");
  });

  it("connector-invoke-live: missing dataSource → fail-closed", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "connector-invoke-live",
      hasConsent: true,
      humanApproved: true,
    });
    expect(r.ok).toBe(false);
    expect(r.missingGate).toBe("data-source-missing");
  });

  it("execute-bash: deny in 'ask' permission-mode", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      permissionMode: "ask",
    });
    expect(r.ok).toBe(false);
    expect(r.missingGate).toBe("permission-mode:freerein-family");
  });

  it("execute-bash: allow in 'freerein'", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      permissionMode: "freerein",
    });
    expect(r.ok).toBe(true);
  });

  it("execute-bash: allow in 'freerein-with-audit'", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      permissionMode: "freerein-with-audit",
    });
    expect(r.ok).toBe(true);
  });

  it("fs-write: deny in 'lane' permission-mode", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "fs-write",
      permissionMode: "lane",
    });
    expect(r.ok).toBe(false);
  });

  it("persist-belief: allow without anything (internal-only)", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "persist-belief",
    });
    expect(r.ok).toBe(true);
  });

  it("spawn-subagent: allow without anything (internal-only)", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "spawn-subagent",
    });
    expect(r.ok).toBe(true);
  });

  it("plan-execute: allow with audit requirement note", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "plan-execute",
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("Audit-Row");
  });

  it("unknown action: fail-closed", () => {
    const r = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      action: "delete-everything" as unknown as ActionKind,
    });
    expect(r.ok).toBe(false);
    expect(r.missingGate).toBe("human-approval");
  });

  it("missing workspaceId/userId: fail-closed", () => {
    const r = canAutoRun({
      workspaceId: "",
      userId: "",
      action: "persist-belief",
    });
    expect(r.ok).toBe(false);
  });

  it("NO_AUTO_RUN_RULES covers all ActionKind values", () => {
    const expected: ActionKind[] = [
      "connector-invoke-live",
      "spawn-subagent",
      "plan-execute",
      "persist-belief",
      "send-external-message",
      "fetch-external-url",
      "execute-bash",
      "fs-write",
    ];
    for (const k of expected) {
      expect(NO_AUTO_RUN_RULES[k]).toBeDefined();
      expect(NO_AUTO_RUN_RULES[k].rationale.length).toBeGreaterThan(0);
    }
  });

  it("send-external-message: needs consent + human-approval", () => {
    const denyA = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "send-external-message",
      dataSource: "whatsapp",
      hasConsent: false,
      humanApproved: true,
    });
    expect(denyA.ok).toBe(false);
    expect(denyA.missingGate).toBe("consent:read-derive-act");

    const ok = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "send-external-message",
      dataSource: "whatsapp",
      hasConsent: true,
      humanApproved: true,
    });
    expect(ok.ok).toBe(true);
  });

  it("fetch-external-url: needs read-derive consent + human-approval", () => {
    const denyB = canAutoRun({
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "fetch-external-url",
      dataSource: "browser-shadow",
      hasConsent: false,
      humanApproved: true,
    });
    expect(denyB.ok).toBe(false);
    expect(denyB.missingGate).toBe("consent:read-derive");
  });
});
