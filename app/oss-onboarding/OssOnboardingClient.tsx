'use client';

/**
 * OSS onboarding wizard — Track B (Robust-v1), 10-step flow.
 *
 * Step order: welcome -> fullaccess -> systemcheck -> install -> engine ->
 * connect -> purpose -> workspace -> github -> finalize -> done.
 *
 * Visual language (unchanged from the prior Jobs/Rams pass):
 *   - Pitch-Black #070707 canvas + 3 radial glows
 *   - SF Pro Display, 15px body minimum
 *   - Single primary CTA per screen (brand-gradient highlight)
 *   - Subtle 0.5px borders (color-mix base, not hard hex)
 *   - 240ms cubic-bezier(0.25, 0.1, 0.25, 1) transitions
 *
 * Every capability is delivered via ROBUST mechanics:
 *   - systemcheck: live preflight + one "Fix safe issues" button (B1)
 *   - install: per-tool consented streamed install with a live log (B2)
 *   - connect: terminal-OAuth auto-verify OR paste key/JSON, equal paths (B3)
 *   - fullaccess: guided deep-links + detected probe, never a gate (B4)
 *   - purpose -> workspace pre-seed, finalize boots + verifies ports (B5)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

import type {
  ConnectState,
  DetectedEngine,
  EngineKind,
  OssOnboardingState,
  OssOnboardingStep,
  UsagePurpose,
} from "@/lib/onboarding/oss-state";
import { stepProgress } from "@/lib/onboarding/oss-state";
import { PURPOSE_OPTIONS } from "@/lib/onboarding/purpose";
import {
  ExtraFoldersRepeater,
  type ExtraRoot,
} from "./ExtraFoldersRepeater";

interface InitialUser {
  id: string;
  displayName: string;
  email: string;
}

interface Props {
  initial: {
    user: InitialUser;
    state: OssOnboardingState;
    /** GitHub OAuth-app configured? (server-side check). */
    githubOAuthReady: boolean;
  };
}

interface EngineProbeApi {
  probes: Array<{
    kind: "claude-cli" | "codex" | "ollama";
    found: boolean;
    location: string | null;
    versionHint: string | null;
  }>;
  recommended: EngineKind;
  detectedAt: string;
}

/** Subset of GET /api/system/health we render. */
type SystemCheckState = "ok" | "degraded" | "error" | "skipped";

interface SystemHealthCheck {
  name: string;
  state: SystemCheckState;
  latencyMs: number;
  detail?: Record<string, unknown>;
  error?: string;
}

interface SystemHealthApi {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptimeSec: number;
  checks: SystemHealthCheck[];
  logDir: string;
  latencyMs: number;
  process: {
    pid: number;
    nodeVersion: string;
    rssMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
  };
}

/** Shape of GET/POST /api/system/preflight (B1). */
interface PreflightCheck {
  id: string;
  title: string;
  severity: "ok" | "warn" | "error";
  detail: string;
  fixable: boolean;
  fixAction: string | null;
}
interface PreflightApi {
  verdict: "passed" | "degraded" | "failed";
  checks: PreflightCheck[];
  fixable: string[];
  results?: Array<{ id: string; outcome: string; detail: string }>;
}

/** Shape of GET/POST /api/onboarding/full-access (B4). */
interface FullAccessProbe {
  platform: "darwin" | "linux" | "win32" | "other";
  fdaGranted: boolean;
  backgroundServiceInstalled: boolean;
  deeplinks: { fullDiskAccess: string; notifications: string } | null;
  posture: "granted" | "partial" | "not-required";
}

const STEP_TITLES: Record<OssOnboardingStep, string> = {
  welcome: "Welcome",
  fullaccess: "Full Access",
  systemcheck: "System Check",
  install: "Install",
  engine: "Engine",
  connect: "Connect",
  purpose: "Purpose",
  workspace: "Workspace",
  github: "GitHub",
  finalize: "Finalize",
  done: "Ready",
};

/** Tools the install step offers, mapped to allowlist target ids (B2). */
const INSTALL_TOOLS: Array<{ id: string; label: string; command: string; shell?: boolean }> = [
  { id: "claude", label: "Claude Code CLI", command: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex", label: "OpenAI Codex CLI", command: "npm i -g @openai/codex" },
  { id: "ollama", label: "Ollama", command: "curl -fsSL https://ollama.com/install.sh | sh", shell: true },
  { id: "ollama-model", label: "Default Ollama model", command: "ollama pull nomic-embed-text" },
];

function slugifyWorkspace(name: string): string {
  const cleaned = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : "workspace";
}

function defaultWorkspacePath(name: string): string {
  return `~/lazyos/workspaces/${slugifyWorkspace(name)}`;
}

export function OssOnboardingClient({ initial }: Props): React.JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<OssOnboardingStep>(initial.state.currentStep);
  const [data, setData] = useState<OssOnboardingState["data"]>(
    initial.state.data ?? {},
  );

  // Engine-Step state
  const [probes, setProbes] = useState<EngineProbeApi | null>(null);
  const [probing, setProbing] = useState(false);

  // Workspace-Step state — name is primary, path is advanced.
  const initialName = initial.state.data?.workspaceLabel ?? "My Workspace";
  const initialRoot = initial.state.data?.workspaceRoot ?? null;
  const [wsName, setWsName] = useState(initialName);
  const [wsAdvanced, setWsAdvanced] = useState(
    initialRoot !== null && initialRoot !== defaultWorkspacePath(initialName),
  );
  const [wsCustomRoot, setWsCustomRoot] = useState(
    initialRoot ?? defaultWorkspacePath(initialName),
  );
  const [wsSens, setWsSens] = useState<"low" | "normal" | "high">(
    initial.state.data?.workspaceSensitivity ?? "low",
  );
  const effectiveWsPath = wsAdvanced ? wsCustomRoot : defaultWorkspacePath(wsName);
  const [extraRoots, setExtraRoots] = useState<ExtraRoot[]>([]);

  // GitHub-Step state — OAuth is primary, PAT is fallback.
  const [ghPatMode, setGhPatMode] = useState(false);
  const [ghPat, setGhPat] = useState("");
  const [ghPatBusy, setGhPatBusy] = useState(false);

  // SystemCheck-Step state — preflight (B1).
  const [preflight, setPreflight] = useState<PreflightApi | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [sysHealth, setSysHealth] = useState<SystemHealthApi | null>(null);

  // Full-Access state (B4).
  const [fullAccess, setFullAccess] = useState<FullAccessProbe | null>(null);
  const [fullAccessBusy, setFullAccessBusy] = useState(false);

  // Install-Step state (B2).
  const [installLogs, setInstallLogs] = useState<Record<string, string[]>>({});
  const [installState, setInstallState] = useState<
    Record<string, "idle" | "running" | "ok" | "failed">
  >({});
  const installAbort = useRef<Record<string, AbortController>>({});

  // Connect-Step state (B3).
  const [connect, setConnect] = useState<ConnectState>(
    initial.state.data?.connect ?? {},
  );
  const [pasteOpen, setPasteOpen] = useState<Record<string, boolean>>({});
  const [pasteKey, setPasteKey] = useState<Record<string, string>>({});
  const [pasteBusy, setPasteBusy] = useState<Record<string, boolean>>({});
  const [claudeJson, setClaudeJson] = useState("");
  const [claudeJsonBusy, setClaudeJsonBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState<Record<string, boolean>>({});

  // Purpose-Step state (B5).
  const [purpose, setPurpose] = useState<UsagePurpose | null>(
    initial.state.data?.usagePurpose ?? null,
  );

  // Finalize-Step state (B5).
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeResult, setFinalizeResult] = useState<{
    status: string;
    ports: Array<{ name: string; port: number; reachable: boolean }>;
    detail: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (input: {
      step: OssOnboardingStep;
      completed?: boolean;
      skipped?: boolean;
      dataPatch?: OssOnboardingState["data"];
    }): Promise<OssOnboardingState | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/onboarding/oss-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error((j.error as string) ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as { state: OssOnboardingState };
        setStep(j.state.currentStep);
        if (j.state.data) setData(j.state.data);
        return j.state;
      } catch (err) {
        setError(err instanceof Error ? err.message : "unknown error");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // ---- Engine probe (engine + connect steps) ----
  const runEngineProbe = useCallback(async (fresh: boolean): Promise<EngineProbeApi | null> => {
    try {
      const url = fresh ? "/api/engine/detect?fresh=1" : "/api/engine/detect";
      const j = (await (await fetch(url)).json()) as EngineProbeApi;
      setProbes(j);
      return j;
    } catch {
      const fallback: EngineProbeApi = {
        probes: [],
        recommended: "none",
        detectedAt: new Date().toISOString(),
      };
      setProbes(fallback);
      return fallback;
    }
  }, []);

  useEffect(() => {
    if ((step !== "engine" && step !== "connect") || probes !== null || probing) return;
    setProbing(true);
    void runEngineProbe(false).finally(() => setProbing(false));
  }, [step, probes, probing, runEngineProbe]);

  // ---- Preflight (systemcheck) ----
  const loadPreflight = useCallback(async (): Promise<void> => {
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const [pf, hp] = await Promise.all([
        fetch("/api/system/preflight").then((r) => r.json() as Promise<PreflightApi>),
        fetch("/api/system/health").then((r) => r.json() as Promise<SystemHealthApi>).catch(() => null),
      ]);
      setPreflight(pf);
      if (hp) setSysHealth(hp);
    } catch (err) {
      setPreflightError(err instanceof Error ? err.message : "Preflight failed.");
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step !== "systemcheck" || preflight !== null || preflightLoading) return;
    void loadPreflight();
  }, [step, preflight, preflightLoading, loadPreflight]);

  const runSafeFix = async (): Promise<void> => {
    if (!preflight || preflight.fixable.length === 0) return;
    setFixing(true);
    setPreflightError(null);
    try {
      const res = await fetch("/api/system/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ healers: preflight.fixable }),
      });
      const j = (await res.json()) as PreflightApi;
      if (!res.ok) throw new Error((j as unknown as { error?: string }).error ?? `HTTP ${res.status}`);
      setPreflight(j);
    } catch (err) {
      setPreflightError(err instanceof Error ? err.message : "Fix failed.");
    } finally {
      setFixing(false);
    }
  };

  // ---- Full Access (B4) ----
  const loadFullAccess = useCallback(async (): Promise<void> => {
    try {
      const j = (await (await fetch("/api/onboarding/full-access")).json()) as FullAccessProbe;
      setFullAccess(j);
    } catch {
      setFullAccess(null);
    }
  }, []);

  useEffect(() => {
    if (step !== "fullaccess" || fullAccess !== null) return;
    void loadFullAccess();
  }, [step, fullAccess, loadFullAccess]);

  const runFullAccessAction = async (
    action: "fda-probe-helper" | "enable-background-service",
  ): Promise<void> => {
    setFullAccessBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/full-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { probe: FullAccessProbe };
      if (!res.ok) throw new Error("action failed");
      setFullAccess(j.probe);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setFullAccessBusy(false);
    }
  };

  // ---- Install (B2, SSE) ----
  const runInstall = (toolId: string, shell: boolean): void => {
    if (installState[toolId] === "running") return;
    setInstallState((s) => ({ ...s, [toolId]: "running" }));
    setInstallLogs((l) => ({ ...l, [toolId]: [`$ starting ${toolId}…`] }));

    const ctrl = new AbortController();
    installAbort.current[toolId] = ctrl;

    const append = (line: string): void =>
      setInstallLogs((l) => ({ ...l, [toolId]: [...(l[toolId] ?? []), line] }));

    void (async () => {
      try {
        const res = await fetch("/api/onboarding/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: toolId, confirmShellInstaller: shell }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          append(`error: ${(j.error as string) ?? `HTTP ${res.status}`}`);
          setInstallState((s) => ({ ...s, [toolId]: "failed" }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const evMatch = /event: (\w+)/.exec(frame);
            const dataMatch = /data: (.+)/.exec(frame);
            if (!evMatch || !dataMatch) continue;
            const ev = evMatch[1];
            let payload: Record<string, unknown> = {};
            try {
              payload = JSON.parse(dataMatch[1]) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (ev === "hello") append(`$ ${payload.command as string}`);
            else if (ev === "log") append(String(payload.line ?? ""));
            else if (ev === "done") {
              const ok = payload.ok === true;
              append(ok ? "✓ done" : `✗ failed (code ${String(payload.code)})`);
              setInstallState((s) => ({ ...s, [toolId]: ok ? "ok" : "failed" }));
              // Refresh engine probe after a CLI install.
              if (ok) void runEngineProbe(true);
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          append("(aborted)");
          setInstallState((s) => ({ ...s, [toolId]: "idle" }));
        } else {
          append(`error: ${err instanceof Error ? err.message : String(err)}`);
          setInstallState((s) => ({ ...s, [toolId]: "failed" }));
        }
      }
    })();
  };

  const abortInstall = (toolId: string): void => {
    installAbort.current[toolId]?.abort();
  };

  // ---- Connect (B3) ----
  const verifyEngine = async (engine: "claude" | "codex" | "ollama"): Promise<void> => {
    setVerifyBusy((b) => ({ ...b, [engine]: true }));
    try {
      // Honest "connected": use the auth-aware detection (/api/system/engines →
      // detectEngines.available), NOT the bare `--version` binary probe. A CLI
      // can be installed yet not logged in; only `available` reflects real auth.
      const engineId =
        engine === "claude" ? "claude-cli" : engine === "codex" ? "codex-cli" : "ollama";
      let authed = false;
      try {
        const res = await fetch("/api/system/engines?fresh=1", { credentials: "same-origin" });
        if (res.ok) {
          const sel = (await res.json()) as {
            available?: Array<{ engine: string; available: boolean }>;
          };
          authed = sel.available?.some((a) => a.engine === engineId && a.available) ?? false;
        }
      } catch {
        /* keep authed=false → stays 'pending' until really authenticated */
      }
      const next: ConnectState = { ...connect, [engine]: authed ? "connected" : "pending" };
      setConnect(next);
      void patch({ step: "connect", dataPatch: { connect: next } });
    } finally {
      setVerifyBusy((b) => ({ ...b, [engine]: false }));
    }
  };

  const submitPasteKey = async (engine: "claude" | "codex"): Promise<void> => {
    const key = (pasteKey[engine] ?? "").trim();
    if (key.length < 8) return;
    setPasteBusy((b) => ({ ...b, [engine]: true }));
    setError(null);
    try {
      const res = await fetch("/api/onboarding/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine, apiKey: key }),
      });
      const j = (await res.json()) as { available?: boolean; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const next: ConnectState = { ...connect, [engine]: j.available ? "connected" : "pending" };
      setConnect(next);
      setPasteKey((p) => ({ ...p, [engine]: "" }));
      void patch({ step: "connect", dataPatch: { connect: next } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key submission failed.");
    } finally {
      setPasteBusy((b) => ({ ...b, [engine]: false }));
    }
  };

  const submitClaudeJson = async (): Promise<void> => {
    if (claudeJson.trim().length < 30) return;
    setClaudeJsonBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users/me/claude-creds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: claudeJson.trim() }),
      });
      const j = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const next: ConnectState = { ...connect, claude: "connected" };
      setConnect(next);
      setClaudeJson("");
      void patch({ step: "connect", dataPatch: { connect: next } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Credentials upload failed.");
    } finally {
      setClaudeJsonBusy(false);
    }
  };

  // ---- GitHub (unchanged paths) ----
  const startGithubOAuth = (): void => {
    window.location.href =
      "/api/auth/github/init?return_to=" +
      encodeURIComponent("/oss-onboarding?from=github-oauth");
  };

  const submitPat = async (): Promise<void> => {
    if (ghPat.trim().length === 0) return;
    setGhPatBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/github/pat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: ghPat.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((j.error as string) ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { login?: string };
      void patch({
        step: "github",
        completed: true,
        dataPatch: { githubStatus: "connected", githubAccount: j.login ?? null },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "PAT verification failed.");
    } finally {
      setGhPatBusy(false);
    }
  };

  useEffect(() => {
    if (step !== "github") return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("from") !== "github-oauth") return;
    window.history.replaceState({}, "", window.location.pathname);
    fetch("/api/auth/github/me", { method: "GET" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { login?: string }) => {
        void patch({
          step: "github",
          completed: true,
          dataPatch: { githubStatus: "connected", githubAccount: j.login ?? null },
        });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "OAuth confirmation failed.");
      });
  }, [step, patch]);

  // ---- Finalize (B5) ----
  const runFinalize = async (): Promise<void> => {
    setFinalizeBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        finalize?: {
          status: string;
          ports: Array<{ name: string; port: number; reachable: boolean }>;
          detail: string;
        };
        error?: string;
      };
      if (!res.ok || !j.finalize) throw new Error(j.error ?? `HTTP ${res.status}`);
      setFinalizeResult(j.finalize);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Finalize failed.");
    } finally {
      setFinalizeBusy(false);
    }
  };

  const enterLazyos = (): void => {
    router.push("/");
  };

  // ---- Step handlers ----
  const goNext = (
    cur: OssOnboardingStep,
    dataPatch?: OssOnboardingState["data"],
    skipped = false,
  ): void => {
    void patch({ step: cur, completed: true, skipped, dataPatch });
  };

  const progress = stepProgress(step);
  const githubOAuthReady = initial.githubOAuthReady;

  return (
    <>
      <Glows />
      <div style={containerStyle} data-test="oss-onboarding-root">
        <div style={stepperStyle} aria-label="Progress">
          {Array.from({ length: progress.total }, (_, i) => i + 1).map((i) => (
            <span
              key={i}
              style={{
                ...dotStyle,
                background:
                  i < progress.current
                    ? "var(--a-now, #c9ff4d)"
                    : i === progress.current
                      ? "color-mix(in oklab, var(--a-now, #c9ff4d) 80%, white)"
                      : "color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)",
              }}
              aria-hidden
            />
          ))}
        </div>
        <div style={crumbStyle} data-test="oss-step-crumb">
          Step {progress.current} of {progress.total} · {STEP_TITLES[step]}
        </div>

        {step === "welcome" ? (
          <section style={panelStyle} data-test="step-welcome">
            <h1 style={titleStyle}>Welcome to lazyOS.</h1>
            <p style={leadStyle}>
              A local-first AI runtime. Your data, your engine, your machine.
            </p>
            <p style={subLeadStyle}>
              A short, robust setup: permissions, a system check that fixes itself,
              one-click tool install, engine connect, and your first workspace.
              Every step can be revisited later.
            </p>
            <p
              style={{ ...subLeadStyle, fontSize: 12, opacity: 0.75, marginTop: 14 }}
              data-test="welcome-disclaimer"
            >
              <strong>AI &amp; privacy.</strong> You are interacting with AI. When you
              use an external engine (Claude / Codex), your prompts are sent to that
              provider. laz.ing can keep personal data on your machine via the built-in
              PII vault — you can enable it at the end of setup, and entity detection can
              even run on a small local model. This is an early step toward GDPR / EU AI
              Act readiness; see <code>docs/privacy.md</code> and{" "}
              <code>docs/compliance.md</code>. Not legal advice.
            </p>
            <div style={btnRowStyle}>
              <button type="button" onClick={() => goNext("welcome")} disabled={busy} style={ctaStyle} data-test="cta-welcome">
                Begin setup
              </button>
            </div>
          </section>
        ) : null}

        {step === "fullaccess" ? (
          <section style={panelStyle} data-test="step-fullaccess">
            <h1 style={titleStyle}>Full Access.</h1>
            <p style={leadStyle}>
              {fullAccess?.platform === "darwin"
                ? "On macOS, some capabilities need a one-time permission in System Settings. This is guided — never forced. You can continue without it."
                : "No special OS permissions are required on this platform. lazyOS works with standard file access."}
            </p>

            {fullAccess?.platform === "darwin" && fullAccess.deeplinks ? (
              <>
                <div style={faRowStyle} data-test="fa-fda">
                  <div>
                    <div style={faTitleStyle}>Full Disk Access</div>
                    <div style={faHintStyle}>
                      {fullAccess.fdaGranted ? "Detected — granted." : "Lets background routines read protected folders."}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <a href={fullAccess.deeplinks.fullDiskAccess} style={ghostLinkBtnStyle} data-test="fa-fda-deeplink">
                      Open Settings
                    </a>
                    <button
                      type="button"
                      onClick={() => void runFullAccessAction("fda-probe-helper")}
                      disabled={fullAccessBusy}
                      style={ghostLinkBtnStyle}
                      data-test="fa-fda-probe"
                    >
                      Re-probe
                    </button>
                  </div>
                </div>
                <div style={faRowStyle} data-test="fa-notif">
                  <div>
                    <div style={faTitleStyle}>Notifications</div>
                    <div style={faHintStyle}>Get notified when long tasks finish or a critic flags something.</div>
                  </div>
                  <a href={fullAccess.deeplinks.notifications} style={ghostLinkBtnStyle} data-test="fa-notif-deeplink">
                    Open Settings
                  </a>
                </div>
                <div style={faRowStyle} data-test="fa-bg">
                  <div>
                    <div style={faTitleStyle}>Background service</div>
                    <div style={faHintStyle}>
                      {fullAccess.backgroundServiceInstalled ? "LaunchAgent installed." : "Optional: run routines when the app is closed."}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void runFullAccessAction("enable-background-service")}
                    disabled={fullAccessBusy || fullAccess.backgroundServiceInstalled}
                    style={ghostLinkBtnStyle}
                    data-test="fa-bg-enable"
                  >
                    {fullAccess.backgroundServiceInstalled ? "Installed" : "Enable"}
                  </button>
                </div>
              </>
            ) : null}

            <div style={btnRowStyle}>
              <button
                type="button"
                onClick={() => goNext("fullaccess", { fullAccessStatus: fullAccess?.posture ?? "skipped" })}
                disabled={busy}
                style={ctaStyle}
                data-test="cta-fullaccess"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={() => goNext("fullaccess", { fullAccessStatus: "skipped" }, true)}
                disabled={busy}
                style={skipBtnStyle}
                data-test="skip-fullaccess"
              >
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "systemcheck" ? (
          <section style={panelStyle} data-test="step-systemcheck">
            <h1 style={titleStyle}>System ready?</h1>
            <p style={leadStyle}>
              Checking database, state directory, secrets, and optional engines.
              Issues with a safe fix can be repaired in one click — nothing destructive.
            </p>

            {preflight ? <PreflightAmpel verdict={preflight.verdict} /> : null}
            {preflightLoading ? <div style={probeStatusStyle} data-test="syschk-loading">Checking dependencies…</div> : null}
            {preflightError ? (
              <div style={sysCheckFetchErrorStyle} role="alert" data-test="syschk-fetch-error">{preflightError}</div>
            ) : null}

            {preflight && !preflightLoading ? (
              <div style={sysCheckListStyle} data-test="syschk-list">
                {preflight.checks.map((c) => (
                  <PreflightRow key={c.id} check={c} />
                ))}
                {sysHealth ? (
                  <>
                    <SystemCheckInfoRow label="Memory (RSS)" value={`${sysHealth.process.rssMB} MB`} />
                    <SystemCheckInfoRow label="Log dir" value={sysHealth.logDir} mono />
                  </>
                ) : null}
              </div>
            ) : null}

            {preflight && preflight.results ? (
              <div style={healResultsStyle} data-test="syschk-heal-results">
                {preflight.results.map((r) => (
                  <div key={r.id} style={healResultRowStyle}>
                    <span style={{ fontWeight: 600 }}>{r.id}</span>: {r.outcome} — {r.detail}
                  </div>
                ))}
              </div>
            ) : null}

            <div style={btnRowStyle}>
              {preflight && preflight.fixable.length > 0 ? (
                <button type="button" onClick={() => void runSafeFix()} disabled={fixing} style={ctaStyle} data-test="syschk-fix">
                  {fixing ? "Fixing…" : `Fix safe issues (${preflight.fixable.length})`}
                </button>
              ) : null}
              <button type="button" onClick={() => void loadPreflight()} disabled={preflightLoading} style={recheckBtnStyle} data-test="syschk-retry">
                Re-check
              </button>
            </div>

            <div style={btnRowStyle}>
              <button
                type="button"
                onClick={() => goNext("systemcheck", { systemcheckStatus: preflight ? preflight.verdict : "failed" })}
                disabled={busy || preflightLoading || preflight === null}
                style={ctaStyle}
                data-test="cta-systemcheck"
              >
                Continue
              </button>
              <button type="button" onClick={() => goNext("systemcheck", { systemcheckStatus: "skipped" }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-systemcheck">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "install" ? (
          <section style={panelStyle} data-test="step-install">
            <h1 style={titleStyle}>Install the tools.</h1>
            <p style={leadStyle}>
              Optional. Install any missing CLI with one click. Each runs the exact
              command shown, streamed live. Nothing runs without your tap.
            </p>
            <div style={installListStyle}>
              {INSTALL_TOOLS.map((tool) => (
                <InstallRow
                  key={tool.id}
                  tool={tool}
                  state={installState[tool.id] ?? "idle"}
                  log={installLogs[tool.id] ?? []}
                  onRun={() => runInstall(tool.id, tool.shell === true)}
                  onAbort={() => abortInstall(tool.id)}
                />
              ))}
            </div>
            <div style={btnRowStyle}>
              <button
                type="button"
                onClick={() => {
                  const okIds = Object.entries(installState).filter(([, v]) => v === "ok").map(([k]) => k);
                  goNext("install", { installSummary: okIds.length > 0 ? `Installed: ${okIds.join(", ")}` : "No tools installed" });
                }}
                disabled={busy}
                style={ctaStyle}
                data-test="cta-install"
              >
                Continue
              </button>
              <button type="button" onClick={() => goNext("install", { installSummary: "Skipped" }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-install">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "engine" ? (
          <section style={panelStyle} data-test="step-engine">
            <h1 style={titleStyle}>Engines on this machine.</h1>
            <p style={leadStyle}>
              lazyOS runs <strong>all available engines in parallel</strong> by default.
              Below is a live availability probe — connecting them is the next step.
            </p>
            {probing ? <div style={probeStatusStyle}>Probing claude-cli, codex, ollama…</div> : null}
            {probes ? (
              <div style={engineGridStyle} data-test="engine-status-grid">
                {probes.probes.map((p) => (
                  <EngineStatusCard key={p.kind} kind={p.kind} found={p.found} versionHint={p.versionHint} />
                ))}
              </div>
            ) : null}
            <div style={btnRowStyle}>
              <button type="button" onClick={() => { void runEngineProbe(true); }} style={recheckBtnStyle} data-test="engine-reprobe">
                Re-probe
              </button>
            </div>
            <div style={btnRowStyle}>
              <button
                type="button"
                onClick={() => {
                  const firstFound = probes?.probes.find((p) => p.found) ?? null;
                  const engine: DetectedEngine | null = firstFound
                    ? { kind: firstFound.kind, location: firstFound.location, versionHint: firstFound.versionHint, autoDetected: true }
                    : null;
                  goNext("engine", { engine, preferredEngine: "parallel-all" });
                }}
                disabled={busy || probing}
                style={ctaStyle}
                data-test="cta-engine"
              >
                Continue
              </button>
              <button type="button" onClick={() => goNext("engine", { engine: null }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-engine">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "connect" ? (
          <section style={panelStyle} data-test="step-connect">
            <h1 style={titleStyle}>Connect your engines.</h1>
            <p style={leadStyle}>
              Two equal paths: sign in via the terminal, or paste an API key.
              Ollama is optional and never blocks.
            </p>

            <ConnectEngineBlock
              engine="claude"
              label="Claude Code"
              loginCmd="claude login"
              status={connect.claude ?? null}
              found={probes?.probes.some((p) => p.kind === "claude-cli" && p.found) ?? false}
              onVerify={() => void verifyEngine("claude")}
              verifyBusy={verifyBusy.claude === true}
              pasteOpen={pasteOpen.claude === true}
              onTogglePaste={() => setPasteOpen((o) => ({ ...o, claude: !o.claude }))}
              pasteKeyVal={pasteKey.claude ?? ""}
              onPasteKey={(v) => setPasteKey((p) => ({ ...p, claude: v }))}
              onSubmitKey={() => void submitPasteKey("claude")}
              pasteBusy={pasteBusy.claude === true}
              pastePlaceholder="ANTHROPIC_API_KEY (sk-ant-…)"
              claudeJson={claudeJson}
              onClaudeJson={setClaudeJson}
              onSubmitClaudeJson={() => void submitClaudeJson()}
              claudeJsonBusy={claudeJsonBusy}
            />

            <ConnectEngineBlock
              engine="codex"
              label="OpenAI Codex"
              loginCmd="codex login"
              status={connect.codex ?? null}
              found={probes?.probes.some((p) => p.kind === "codex" && p.found) ?? false}
              onVerify={() => void verifyEngine("codex")}
              verifyBusy={verifyBusy.codex === true}
              pasteOpen={pasteOpen.codex === true}
              onTogglePaste={() => setPasteOpen((o) => ({ ...o, codex: !o.codex }))}
              pasteKeyVal={pasteKey.codex ?? ""}
              onPasteKey={(v) => setPasteKey((p) => ({ ...p, codex: v }))}
              onSubmitKey={() => void submitPasteKey("codex")}
              pasteBusy={pasteBusy.codex === true}
              pastePlaceholder="OPENAI_API_KEY (sk-…)"
            />

            <div style={connectOllamaStyle} data-test="connect-ollama">
              <div>
                <div style={faTitleStyle}>Ollama (optional)</div>
                <div style={faHintStyle}>
                  {probes?.probes.some((p) => p.kind === "ollama" && p.found)
                    ? "Detected — local models ready."
                    : "Install Ollama and run `ollama serve`. Never blocks setup."}
                </div>
              </div>
              <button type="button" onClick={() => void verifyEngine("ollama")} disabled={verifyBusy.ollama} style={ghostLinkBtnStyle} data-test="connect-ollama-verify">
                Re-probe
              </button>
            </div>

            <div style={btnRowStyle}>
              <button type="button" onClick={() => goNext("connect", { connect })} disabled={busy} style={ctaStyle} data-test="cta-connect">
                Continue
              </button>
              <button type="button" onClick={() => goNext("connect", { connect }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-connect">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "purpose" ? (
          <section style={panelStyle} data-test="step-purpose">
            <h1 style={titleStyle}>How will you use lazyOS?</h1>
            <p style={leadStyle}>This pre-fills sensible defaults for your first workspace. You can change everything next.</p>
            <div style={radioGroupStyle}>
              {PURPOSE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPurpose(opt.id)}
                  style={{
                    ...radioCardStyle,
                    borderColor: purpose === opt.id ? "var(--a-now, #c9ff4d)" : "color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)",
                    background: purpose === opt.id ? "color-mix(in oklab, var(--a-now, #c9ff4d) 6%, transparent)" : "color-mix(in oklab, #ffffff 2%, transparent)",
                  }}
                  data-test={`purpose-${opt.id}`}
                  data-selected={purpose === opt.id ? "true" : "false"}
                >
                  <span
                    style={{
                      ...radioDotStyle,
                      background: purpose === opt.id ? "var(--a-now, #c9ff4d)" : "transparent",
                      borderColor: purpose === opt.id ? "var(--a-now, #c9ff4d)" : "color-mix(in oklab, var(--ink, #f5f5f5) 30%, transparent)",
                    }}
                    aria-hidden
                  />
                  <span style={radioLabelWrapStyle}>
                    <span style={radioTitleStyle}>{opt.title}</span>
                    <span style={radioHintStyle}>{opt.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
            <div style={btnRowStyle}>
              <button
                type="button"
                onClick={() => {
                  const seed = purpose ? PURPOSE_OPTIONS.find((o) => o.id === purpose) : null;
                  if (purpose) {
                    // Pre-seed workspace fields from the purpose map.
                    const label = purpose === "agency" ? "Client Work" : purpose === "contributor" ? "lazyOS Dev" : "My Workspace";
                    setWsName(label);
                    setWsSens(purpose === "agency" ? "normal" : "low");
                  }
                  void seed;
                  goNext("purpose", { usagePurpose: purpose ?? "personal" });
                }}
                disabled={busy || purpose === null}
                style={ctaStyle}
                data-test="cta-purpose"
              >
                Continue
              </button>
              <button type="button" onClick={() => goNext("purpose", { usagePurpose: "personal" }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-purpose">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "workspace" ? (
          <section style={panelStyle} data-test="step-workspace">
            <h1 style={titleStyle}>Where should lazyOS work?</h1>
            <p style={leadStyle}>Give your workspace a name. lazyOS keeps every file, chat, and decision scoped to it.</p>
            <div style={fieldGroupStyle}>
              <label style={labelStyle} htmlFor="ws-name">Workspace name</label>
              <input id="ws-name" type="text" value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="My Workspace" maxLength={120} style={inputStyle} disabled={busy} data-test="ws-name" autoFocus />
              <p style={hintStyle} data-test="ws-derived-path">Stored at <code style={codeStyle}>{effectiveWsPath}</code></p>
            </div>
            <button type="button" onClick={() => setWsAdvanced((v) => !v)} style={disclosureStyle} data-test="ws-advanced-toggle" aria-expanded={wsAdvanced}>
              {wsAdvanced ? "Hide advanced" : "Use a custom location"}
            </button>
            {wsAdvanced ? (
              <div style={advancedPanelStyle} data-test="ws-advanced-panel">
                <label style={labelStyle} htmlFor="ws-custom-root">Custom path</label>
                <input id="ws-custom-root" type="text" value={wsCustomRoot} onChange={(e) => setWsCustomRoot(e.target.value)} placeholder="~/projects/my-workspace" style={inputStyle} disabled={busy} data-test="ws-custom-root" />
                <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="ws-sens">Sensitivity</label>
                <select id="ws-sens" value={wsSens} onChange={(e) => setWsSens(e.target.value as "low" | "normal" | "high")} style={selectStyle} disabled={busy} data-test="ws-sens">
                  <option value="low">Low — standard project</option>
                  <option value="normal">Normal — client work</option>
                  <option value="high">High — private or sensitive</option>
                </select>
                <ExtraFoldersRepeater value={extraRoots} onChange={setExtraRoots} disabled={busy} />
              </div>
            ) : null}
            <div style={btnRowStyle}>
              <button type="button" onClick={() => goNext("workspace", { workspaceRoot: effectiveWsPath, workspaceLabel: wsName.trim(), workspaceSensitivity: wsSens })} disabled={busy || wsName.trim().length === 0} style={ctaStyle} data-test="cta-workspace">
                Continue
              </button>
              <button type="button" onClick={() => goNext("workspace", { workspaceRoot: null, workspaceLabel: null }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-workspace">
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === "github" ? (
          <section style={panelStyle} data-test="step-github">
            <h1 style={titleStyle}>Connect GitHub.</h1>
            <p style={leadStyle}>Optional. Lets lazyOS open PRs, read issues, and sync branches across your repos.</p>
            {githubOAuthReady ? (
              <>
                <div style={btnRowStyle}>
                  <button type="button" onClick={startGithubOAuth} disabled={busy} style={ctaStyle} data-test="cta-github-oauth">
                    <GitHubMark />Sign in with GitHub
                  </button>
                  <button type="button" onClick={() => goNext("github", { githubStatus: "skipped", githubAccount: null }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-github">Skip</button>
                </div>
                <button type="button" onClick={() => setGhPatMode((v) => !v)} style={disclosureStyle} data-test="gh-pat-toggle" aria-expanded={ghPatMode}>
                  {ghPatMode ? "Hide token option" : "Use a personal access token instead"}
                </button>
                {ghPatMode ? <PatFallback pat={ghPat} onChange={setGhPat} onSubmit={() => void submitPat()} busy={ghPatBusy} /> : null}
              </>
            ) : (
              <>
                <div style={oauthMissingNoteStyle} data-test="oauth-not-configured">
                  <span style={oauthMissingIconStyle}><GitHubMark /></span>
                  <div>
                    <p style={oauthMissingTitleStyle}>OAuth app not configured yet</p>
                    <p style={oauthMissingBodyStyle}>
                      Set up a one-time OAuth app to enable single-sign-in for everyone using this server.{" "}
                      <a href="https://github.com/settings/developers" target="_blank" rel="noopener noreferrer" style={linkStyle}>Open GitHub Developer Settings</a>, create an OAuth app, then add the env vars and restart.
                    </p>
                  </div>
                </div>
                <PatFallback pat={ghPat} onChange={setGhPat} onSubmit={() => void submitPat()} busy={ghPatBusy} />
                <div style={btnRowStyle}>
                  <button type="button" onClick={() => goNext("github", { githubStatus: "skipped", githubAccount: null }, true)} disabled={busy} style={skipBtnStyle} data-test="skip-github">Skip GitHub</button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {step === "finalize" ? (
          <section style={panelStyle} data-test="step-finalize">
            <h1 style={titleStyle}>Finalize.</h1>
            <p style={leadStyle}>
              lazyOS will boot the agent server and verify the web and agent ports.
              This is the last step.
            </p>
            {finalizeResult ? (
              <div style={sysCheckListStyle} data-test="finalize-result">
                <div style={{ ...sysCheckRowStyle, gridTemplateRows: "auto" }}>
                  <span style={{ ...sysCheckDotStyle, background: finalizeResult.status === "ready" ? "var(--a-now, #c9ff4d)" : "var(--a-warn, #ffb84d)" }} aria-hidden />
                  <span style={sysCheckRowNameStyle}>{finalizeResult.status === "ready" ? "All services ready" : "Degraded — agent can be started later"}</span>
                </div>
                {finalizeResult.ports.map((p) => (
                  <div key={p.name} style={{ ...sysCheckRowStyle, gridTemplateRows: "auto" }} data-test={`finalize-port-${p.name}`}>
                    <span style={{ ...sysCheckDotStyle, background: p.reachable ? "var(--a-now, #c9ff4d)" : "var(--a-warn, #ffb84d)" }} aria-hidden />
                    <span style={sysCheckRowNameStyle}>{p.name} server</span>
                    <span style={sysCheckRowLatencyStyle}>:{p.port} {p.reachable ? "up" : "down"}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <PrivacyVaultToggle />
            <div style={btnRowStyle}>
              {finalizeResult ? (
                <button type="button" onClick={enterLazyos} style={ctaStyle} data-test="cta-enter">Enter lazyOS</button>
              ) : (
                <button type="button" onClick={() => void runFinalize()} disabled={finalizeBusy} style={ctaStyle} data-test="cta-finalize">
                  {finalizeBusy ? "Booting…" : "Boot and finish"}
                </button>
              )}
            </div>
          </section>
        ) : null}

        {step === "done" ? (
          <section style={panelStyle} data-test="step-done">
            <h1 style={titleStyle}>Ready, {initial.user.displayName}.</h1>
            <p style={leadStyle}>Setup saved. Your engines, workspace, and defaults are remembered.</p>
            <ul style={summaryListStyle}>
              <li><span style={summaryKeyStyle}>Engine</span><span style={summaryValStyle}>{engineLabel(data?.engine?.kind ?? "none")}</span></li>
              <li><span style={summaryKeyStyle}>Workspace</span><span style={summaryValStyle}>{data?.workspaceLabel ?? "Skipped"}</span></li>
              <li><span style={summaryKeyStyle}>GitHub</span><span style={summaryValStyle}>{data?.githubStatus === "connected" ? (data?.githubAccount ?? "Connected") : "Skipped"}</span></li>
              <li><span style={summaryKeyStyle}>Services</span><span style={summaryValStyle}>{data?.finalizeStatus ?? "—"}</span></li>
            </ul>
            <div style={btnRowStyle}>
              <button type="button" onClick={enterLazyos} disabled={busy} style={ctaStyle} data-test="cta-done">Enter lazyOS</button>
            </div>
          </section>
        ) : null}

        {error ? <div style={errorBoxStyle} role="alert" data-test="oss-error">{error}</div> : null}
      </div>
    </>
  );
}

// ---- Privacy / PII vault toggle (finalize step) --------------------------

function PrivacyVaultToggle() {
  const [vault, setVault] = useState(false);
  const [ner, setNer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const apply = async (nextVault: boolean, nextNer: boolean): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/privacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ vault: nextVault, ner: nextNer }),
      });
      const j = (await res.json().catch(() => null)) as { note?: string | null } | null;
      setNote(j?.note ?? null);
    } catch {
      /* non-fatal */
    } finally {
      setBusy(false);
    }
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    fontSize: 13,
    margin: "8px 0",
    cursor: "pointer",
  };
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, var(--ink, #f5f5f5) 10%, transparent)",
        borderRadius: 10,
        padding: 14,
        margin: "14px 0",
        background: "color-mix(in oklab, #ffffff 2%, transparent)",
      }}
      data-test="privacy-vault"
    >
      <strong style={{ fontSize: 13 }}>Privacy — keep personal data local</strong>
      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={vault}
          disabled={busy}
          onChange={(e) => {
            setVault(e.target.checked);
            void apply(e.target.checked, ner);
          }}
          data-test="privacy-vault-toggle"
        />
        <span>
          When you use an external engine (Claude / Codex), replace personal entities
          (emails, IBANs, cards, phones, IPs) with local placeholders. Real values are
          encrypted on this machine; the cloud only ever sees the placeholders.
        </span>
      </label>
      {vault ? (
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={ner}
            disabled={busy}
            onChange={(e) => {
              setNer(e.target.checked);
              void apply(vault, e.target.checked);
            }}
            data-test="privacy-ner-toggle"
          />
          <span>Also detect names (person / org / location) with a small local model (needs Ollama).</span>
        </label>
      ) : null}
      {note ? <p style={{ fontSize: 12, opacity: 0.8, margin: "6px 0 0" }}>{note}</p> : null}
      <p style={{ fontSize: 11, opacity: 0.6, margin: "8px 0 0" }}>
        An early step toward GDPR / EU AI Act readiness — see docs/privacy.md and
        docs/compliance.md. Not legal advice.
      </p>
    </div>
  );
}

// ---- Connect engine block (B3) -------------------------------------------

function ConnectEngineBlock(props: {
  engine: "claude" | "codex";
  label: string;
  loginCmd: string;
  status: ConnectState[keyof ConnectState];
  found: boolean;
  onVerify: () => void;
  verifyBusy: boolean;
  pasteOpen: boolean;
  onTogglePaste: () => void;
  pasteKeyVal: string;
  onPasteKey: (v: string) => void;
  onSubmitKey: () => void;
  pasteBusy: boolean;
  pastePlaceholder: string;
  claudeJson?: string;
  onClaudeJson?: (v: string) => void;
  onSubmitClaudeJson?: () => void;
  claudeJsonBusy?: boolean;
}): React.JSX.Element {
  const connected = props.found || props.status === "connected";
  return (
    <div style={connectBlockStyle} data-test={`connect-${props.engine}`} data-connected={connected ? "true" : "false"}>
      <div style={statusHeaderStyle}>
        <span style={statusTitleStyle}>{props.label}</span>
        <span style={{ ...statusBadgeStyle, color: connected ? "var(--a-now, #c9ff4d)" : "var(--ink-3, #6b6b6b)" }} data-test={`connect-badge-${props.engine}`}>
          {connected ? "connected" : "not connected"}
        </span>
      </div>

      <div style={connectPathStyle}>
        <div style={faHintStyle}>Path A — sign in via terminal:</div>
        <div style={cmdRowStyle}>
          <code style={{ ...codeStyle, flex: 1 }} data-test={`connect-cmd-${props.engine}`}>{props.loginCmd}</code>
          <CopyButton text={props.loginCmd} />
        </div>
        <button type="button" onClick={props.onVerify} disabled={props.verifyBusy} style={{ ...ghostLinkBtnStyle, marginTop: 8 }} data-test={`connect-verify-${props.engine}`}>
          {props.verifyBusy ? "Checking…" : "I signed in — verify"}
        </button>
      </div>

      <div style={connectPathStyle}>
        <button type="button" onClick={props.onTogglePaste} style={disclosureStyle} data-test={`connect-paste-toggle-${props.engine}`} aria-expanded={props.pasteOpen}>
          {props.pasteOpen ? "Hide key option" : "Path B — paste an API key instead"}
        </button>
        {props.pasteOpen ? (
          <div style={patPanelStyle}>
            <input type="password" value={props.pasteKeyVal} onChange={(e) => props.onPasteKey(e.target.value)} placeholder={props.pastePlaceholder} autoComplete="off" spellCheck={false} style={inputStyle} disabled={props.pasteBusy} data-test={`connect-key-input-${props.engine}`} />
            <div style={btnRowStyle}>
              <button type="button" onClick={props.onSubmitKey} disabled={props.pasteBusy || props.pasteKeyVal.trim().length < 8} style={{ ...ctaStyle, fontSize: 13, padding: "10px 18px" }} data-test={`connect-key-submit-${props.engine}`}>
                {props.pasteBusy ? "Saving…" : "Save key"}
              </button>
            </div>
            {props.engine === "claude" && props.onClaudeJson ? (
              <div style={{ marginTop: 12 }}>
                <div style={faHintStyle}>Or paste your Claude credentials JSON (~/.claude/.credentials.json):</div>
                <textarea value={props.claudeJson ?? ""} onChange={(e) => props.onClaudeJson?.(e.target.value)} placeholder='{"oauthAccount":…}' spellCheck={false} style={{ ...inputStyle, minHeight: 80, fontFamily: "var(--font-mono, ui-monospace)", fontSize: 12 }} disabled={props.claudeJsonBusy} data-test="connect-claude-json" />
                <div style={btnRowStyle}>
                  <button type="button" onClick={props.onSubmitClaudeJson} disabled={props.claudeJsonBusy || (props.claudeJson ?? "").trim().length < 30} style={{ ...ctaStyle, fontSize: 13, padding: "10px 18px" }} data-test="connect-claude-json-submit">
                    {props.claudeJsonBusy ? "Saving…" : "Save credentials"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      style={ghostLinkBtnStyle}
      data-test="copy-btn"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ---- Install row (B2) -----------------------------------------------------

function InstallRow({
  tool,
  state,
  log,
  onRun,
  onAbort,
}: {
  tool: { id: string; label: string; command: string };
  state: "idle" | "running" | "ok" | "failed";
  log: string[];
  onRun: () => void;
  onAbort: () => void;
}): React.JSX.Element {
  return (
    <div style={installRowStyle} data-test={`install-${tool.id}`} data-state={state}>
      <div style={statusHeaderStyle}>
        <div>
          <div style={statusTitleStyle}>{tool.label}</div>
          <code style={{ ...codeStyle, fontSize: 11 }}>{tool.command}</code>
        </div>
        {state === "running" ? (
          <button type="button" onClick={onAbort} style={ghostLinkBtnStyle} data-test={`install-abort-${tool.id}`}>Abort</button>
        ) : (
          <button type="button" onClick={onRun} disabled={state === "ok"} style={{ ...ghostLinkBtnStyle, borderColor: state === "ok" ? "var(--a-now, #c9ff4d)" : undefined }} data-test={`install-run-${tool.id}`}>
            {state === "ok" ? "Installed" : state === "failed" ? "Retry" : `Install`}
          </button>
        )}
      </div>
      {log.length > 0 ? (
        <pre style={installLogStyle} data-test={`install-log-${tool.id}`}>{log.slice(-40).join("\n")}</pre>
      ) : null}
    </div>
  );
}

// ---- Preflight sub-components (B1) ----------------------------------------

function PreflightAmpel({ verdict }: { verdict: "passed" | "degraded" | "failed" }): React.JSX.Element {
  const color = verdict === "failed" ? "var(--a-error, #ff6464)" : verdict === "degraded" ? "var(--a-warn, #ffb84d)" : "var(--a-now, #c9ff4d)";
  const label = verdict === "failed" ? "Action required" : verdict === "degraded" ? "Minor issues — fixable" : "System ready";
  return (
    <div style={{ ...sysAmpelStyle, borderColor: `color-mix(in oklab, ${color} 35%, transparent)` }} data-test="syschk-ampel" data-verdict={verdict}>
      <span style={{ ...sysAmpelDotStyle, background: color }} aria-hidden />
      <span style={{ ...sysAmpelLabelStyle, color }}>{label}</span>
    </div>
  );
}

function PreflightRow({ check }: { check: PreflightCheck }): React.JSX.Element {
  const dotColor = check.severity === "ok" ? "var(--a-now, #c9ff4d)" : check.severity === "warn" ? "var(--a-warn, #ffb84d)" : "var(--a-error, #ff6464)";
  return (
    <div style={sysCheckRowStyle} data-test={`syschk-row-${check.id}`}>
      <span style={{ ...sysCheckDotStyle, background: dotColor }} aria-label={check.severity} />
      <span style={sysCheckRowNameStyle}>{check.title}</span>
      <span style={sysCheckRowLatencyStyle}>{check.fixable && check.severity !== "ok" ? "fixable" : ""}</span>
      <span style={sysCheckRowHintStyle} data-test={`syschk-detail-${check.id}`}>{check.detail}</span>
    </div>
  );
}

function SystemCheckInfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div style={{ ...sysCheckRowStyle, opacity: 0.65 }} data-test={`syschk-info-${label}`}>
      <span style={{ ...sysCheckDotStyle, background: "transparent" }} aria-hidden />
      <span style={sysCheckRowNameStyle}>{label}</span>
      <span style={{ ...sysCheckRowLatencyStyle, fontFamily: mono ? "var(--font-mono, ui-monospace)" : undefined, fontSize: mono ? 11 : undefined, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

// ---- Engine status card (engine step) ------------------------------------

function EngineStatusCard({ kind, found, versionHint }: { kind: EngineKind; found: boolean; versionHint: string | null }): React.JSX.Element {
  const connectHint =
    kind === "claude-cli" ? "Install via `npm i -g @anthropic-ai/claude-code` + run `claude login`"
      : kind === "codex" ? "Install via `npm i -g @openai/codex` + run `codex login`"
        : kind === "ollama" ? "Install Ollama.app and run `ollama serve`"
          : "—";
  return (
    <div style={{ ...statusCardStyle, borderColor: found ? "var(--a-now, #c9ff4d)" : "color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)" }} data-test={`engine-status-${kind}`} data-available={found ? "true" : "false"}>
      <div style={statusHeaderStyle}>
        <span style={statusTitleStyle}>{engineLabel(kind)}</span>
        <span style={{ ...statusBadgeStyle, color: found ? "var(--a-now, #c9ff4d)" : "var(--a-warn, #ffb84d)" }} data-test={`engine-badge-${kind}`}>
          {found ? "available" : "not found"}
        </span>
      </div>
      <div style={statusHintStyle}>{found ? versionHint ?? "ready" : connectHint}</div>
    </div>
  );
}

function PatFallback({ pat, onChange, onSubmit, busy }: { pat: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean }): React.JSX.Element {
  return (
    <div style={patPanelStyle} data-test="gh-pat-panel">
      <label style={labelStyle} htmlFor="gh-pat">Personal access token</label>
      <input id="gh-pat" type="password" value={pat} onChange={(e) => onChange(e.target.value)} placeholder="ghp_…" autoComplete="off" spellCheck={false} style={inputStyle} disabled={busy} data-test="gh-pat-input" />
      <p style={hintStyle}>
        Create one at{" "}
        <a href="https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=lazyOS" target="_blank" rel="noopener noreferrer" style={linkStyle}>github.com/settings/tokens</a>{" "}
        with <code style={codeStyle}>repo</code> + <code style={codeStyle}>read:user</code>.
      </p>
      <div style={btnRowStyle}>
        <button type="button" onClick={onSubmit} disabled={busy || pat.trim().length === 0} style={{ ...ctaStyle, fontSize: 13, padding: "10px 18px" }} data-test="cta-github-pat">
          {busy ? "Verifying…" : "Verify and connect"}
        </button>
      </div>
    </div>
  );
}

function GitHubMark(): React.JSX.Element {
  return (
    <svg aria-hidden width={16} height={16} viewBox="0 0 16 16" style={{ display: "inline-block", marginRight: 8, verticalAlign: "-2px" }}>
      <path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.37c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.16-.89-1.16-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.34.66.07-.52.28-.87.51-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.49v2.21c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

function Glows(): React.JSX.Element {
  return (
    <div aria-hidden style={glowWrapStyle}>
      <div style={{ ...glowStyle, top: "-20%", left: "-10%", background: "radial-gradient(closest-side, color-mix(in oklab, var(--a-now, #c9ff4d) 5%, transparent), transparent 70%)" }} />
      <div style={{ ...glowStyle, bottom: "-30%", right: "-15%", background: "radial-gradient(closest-side, color-mix(in oklab, #6effe0 4%, transparent), transparent 70%)" }} />
      <div style={{ ...glowStyle, top: "40%", right: "30%", background: "radial-gradient(closest-side, color-mix(in oklab, #ffffff 2.5%, transparent), transparent 70%)", width: 600, height: 600 }} />
    </div>
  );
}

function engineLabel(k: EngineKind): string {
  switch (k) {
    case "claude-cli": return "Claude CLI";
    case "codex": return "Codex CLI";
    case "ollama": return "Ollama";
    case "none": return "No engine";
  }
}

// ---- Styles ---------------------------------------------------------------

const EASE = "cubic-bezier(0.25, 0.1, 0.25, 1)";
const T = `240ms ${EASE}`;

const engineGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, maxWidth: 640 };
const statusCardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 12, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)", transition: `border-color ${T}, background 240ms` };
const statusHeaderStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const statusTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--ink, #f5f5f5)", letterSpacing: "-0.005em" };
const statusBadgeStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" };
const statusHintStyle: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: "var(--ink-3, #6b6b6b)", fontFamily: "var(--font-mono, ui-monospace)" };

const containerStyle: CSSProperties = { maxWidth: 640, margin: "clamp(48px, 10vw, 128px) auto 96px", padding: "0 28px", position: "relative", zIndex: 1 };
const glowWrapStyle: CSSProperties = { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" };
const glowStyle: CSSProperties = { position: "absolute", width: 720, height: 720, filter: "blur(40px)" };
const stepperStyle: CSSProperties = { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" };
const dotStyle: CSSProperties = { width: 6, height: 6, borderRadius: 999, display: "inline-block", transition: `background ${T}` };
const crumbStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in oklab, var(--ink, #f5f5f5) 45%, transparent)", marginBottom: 40 };
const panelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 20 };
const titleStyle: CSSProperties = { fontSize: "clamp(30px, 5vw, 44px)", fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1.05, margin: 0, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", color: "var(--ink, #f5f5f5)" };
const leadStyle: CSSProperties = { fontSize: 17, lineHeight: 1.55, color: "color-mix(in oklab, var(--ink, #f5f5f5) 75%, transparent)", margin: 0, maxWidth: 540, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)" };
const subLeadStyle: CSSProperties = { ...leadStyle, fontSize: 15, color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)" };
const fieldGroupStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 };
const labelStyle: CSSProperties = { display: "block", fontFamily: "var(--font-mono, ui-monospace)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)", marginBottom: 0 };
const inputStyle: CSSProperties = { padding: "13px 16px", fontSize: 15, borderRadius: 10, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)", background: "color-mix(in oklab, #ffffff 2.5%, transparent)", color: "var(--ink, #f5f5f5)", fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", width: "100%", maxWidth: 480, boxSizing: "border-box", transition: `border-color ${T}, background ${T}`, outline: "none" };
const selectStyle: CSSProperties = { ...inputStyle, appearance: "none" };
const hintStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)", margin: 0 };
const codeStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace)", fontSize: 12, padding: "2px 6px", borderRadius: 4, background: "color-mix(in oklab, #ffffff 5%, transparent)", color: "color-mix(in oklab, var(--ink, #f5f5f5) 85%, transparent)" };
const disclosureStyle: CSSProperties = { alignSelf: "flex-start", background: "transparent", border: "none", padding: "4px 0", fontSize: 13, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, transition: `color ${T}` };
const advancedPanelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "16px 0 4px" };
const ctaStyle: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", alignSelf: "flex-start", padding: "13px 24px", fontSize: 14, fontWeight: 500, borderRadius: 10, border: "none", background: "linear-gradient(135deg, var(--a-now, #c9ff4d) 0%, color-mix(in oklab, var(--a-now, #c9ff4d) 70%, #6effe0) 100%)", color: "#070707", cursor: "pointer", marginTop: 4, transition: `transform ${T}, opacity ${T}, filter ${T}`, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)" };
const skipBtnStyle: CSSProperties = { alignSelf: "flex-start", padding: "13px 20px", fontSize: 13, fontFamily: "var(--font-mono, ui-monospace)", letterSpacing: "0.06em", textTransform: "uppercase", borderRadius: 10, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 10%, transparent)", background: "transparent", color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)", cursor: "pointer", marginTop: 4, transition: `border-color ${T}, color ${T}` };
const ghostLinkBtnStyle: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "8px 14px", fontSize: 12, fontFamily: "var(--font-mono, ui-monospace)", letterSpacing: "0.04em", borderRadius: 8, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 14%, transparent)", background: "transparent", color: "color-mix(in oklab, var(--ink, #f5f5f5) 70%, transparent)", cursor: "pointer", textDecoration: "none", transition: `border-color ${T}, color ${T}` };
const btnRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 };
const radioGroupStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, maxWidth: 540 };
const radioCardStyle: CSSProperties = { appearance: "none", display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", borderRadius: 12, border: "0.5px solid", textAlign: "left", width: "100%", transition: `background ${T}, border-color ${T}`, color: "var(--ink, #f5f5f5)", fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", cursor: "pointer" };
const radioDotStyle: CSSProperties = { width: 14, height: 14, borderRadius: 999, border: "1.5px solid", flexShrink: 0, marginTop: 4, transition: `background ${T}, border-color ${T}` };
const radioLabelWrapStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const radioTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 500, color: "var(--ink, #f5f5f5)", display: "flex", alignItems: "center", gap: 8 };
const radioHintStyle: CSSProperties = { fontSize: 13, color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)", lineHeight: 1.5 };
const probeStatusStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace)", fontSize: 12, color: "color-mix(in oklab, var(--ink, #f5f5f5) 45%, transparent)", letterSpacing: "0.06em" };
const summaryListStyle: CSSProperties = { margin: "8px 0 0", padding: 0, listStyle: "none", fontSize: 14, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 };
const summaryKeyStyle: CSSProperties = { display: "inline-block", width: 140, fontFamily: "var(--font-mono, ui-monospace)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)" };
const summaryValStyle: CSSProperties = { color: "var(--ink, #f5f5f5)", fontWeight: 500 };
const oauthMissingNoteStyle: CSSProperties = { display: "flex", gap: 14, padding: "16px 18px", borderRadius: 12, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 10%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)", alignItems: "flex-start", maxWidth: 540 };
const oauthMissingIconStyle: CSSProperties = { flexShrink: 0, marginTop: 2, color: "color-mix(in oklab, var(--ink, #f5f5f5) 70%, transparent)" };
const oauthMissingTitleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 500, color: "var(--ink, #f5f5f5)" };
const oauthMissingBodyStyle: CSSProperties = { margin: "6px 0 0", fontSize: 13, lineHeight: 1.55, color: "color-mix(in oklab, var(--ink, #f5f5f5) 60%, transparent)" };
const linkStyle: CSSProperties = { color: "var(--a-now, #c9ff4d)", textDecoration: "underline", textUnderlineOffset: 2 };
const patPanelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "16px 0 0", maxWidth: 540 };
const errorBoxStyle: CSSProperties = { marginTop: 24, padding: "12px 16px", borderRadius: 10, background: "color-mix(in oklab, #ff6464 12%, transparent)", border: "0.5px solid color-mix(in oklab, #ff6464 30%, transparent)", color: "color-mix(in oklab, #ff8888 90%, white)", fontSize: 13, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", maxWidth: 540 };

// SystemCheck / preflight styles
const sysAmpelStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 10, border: "0.5px solid", background: "color-mix(in oklab, #ffffff 2%, transparent)", transition: `border-color ${T}, background ${T}`, alignSelf: "flex-start", maxWidth: 480 };
const sysAmpelDotStyle: CSSProperties = { width: 8, height: 8, borderRadius: 999, flexShrink: 0, transition: `background ${T}` };
const sysAmpelLabelStyle: CSSProperties = { fontSize: 14, fontWeight: 500, fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", letterSpacing: "-0.01em" };
const sysCheckListStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 0, maxWidth: 540, borderRadius: 12, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)", overflow: "hidden" };
const sysCheckRowStyle: CSSProperties = { display: "grid", gridTemplateColumns: "16px 1fr auto", gridTemplateRows: "auto auto", alignItems: "center", columnGap: 10, rowGap: 3, padding: "12px 16px", borderBottom: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 6%, transparent)", transition: `background ${T}` };
const sysCheckDotStyle: CSSProperties = { width: 8, height: 8, borderRadius: 999, flexShrink: 0, gridColumn: "1", gridRow: "1", transition: `background ${T}` };
const sysCheckRowNameStyle: CSSProperties = { fontSize: 13, fontWeight: 500, color: "var(--ink, #f5f5f5)", fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)", gridColumn: "2", gridRow: "1" };
const sysCheckRowLatencyStyle: CSSProperties = { fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)", color: "color-mix(in oklab, var(--ink, #f5f5f5) 40%, transparent)", gridColumn: "3", gridRow: "1", textAlign: "right" };
const sysCheckRowHintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)", fontFamily: "var(--font-mono, ui-monospace)", gridColumn: "2 / span 2", gridRow: "2" };
const sysCheckFetchErrorStyle: CSSProperties = { padding: "10px 14px", borderRadius: 10, background: "color-mix(in oklab, #ff6464 8%, transparent)", border: "0.5px solid color-mix(in oklab, #ff6464 22%, transparent)", color: "color-mix(in oklab, #ff8888 90%, white)", fontSize: 13, fontFamily: "var(--font-mono, ui-monospace)", maxWidth: 480 };
const recheckBtnStyle: CSSProperties = { alignSelf: "flex-start", padding: "8px 14px", fontSize: 12, fontFamily: "var(--font-mono, ui-monospace)", letterSpacing: "0.06em", textTransform: "uppercase", borderRadius: 8, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 14%, transparent)", background: "transparent", color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)", cursor: "pointer", transition: `border-color ${T}, color ${T}` };
const healResultsStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, maxWidth: 540, fontSize: 12, fontFamily: "var(--font-mono, ui-monospace)", color: "color-mix(in oklab, var(--ink, #f5f5f5) 60%, transparent)" };
const healResultRowStyle: CSSProperties = { lineHeight: 1.5 };

// Full-access styles
const faRowStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderRadius: 12, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)", maxWidth: 540 };
const faTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--ink, #f5f5f5)" };
const faHintStyle: CSSProperties = { fontSize: 12, color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)", marginTop: 3, lineHeight: 1.45 };

// Install styles
const installListStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 };
const installRowStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 12, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)" };
const installLogStyle: CSSProperties = { margin: 0, padding: "10px 12px", borderRadius: 8, background: "color-mix(in oklab, #000000 40%, transparent)", color: "color-mix(in oklab, var(--ink, #f5f5f5) 80%, transparent)", fontFamily: "var(--font-mono, ui-monospace)", fontSize: 11, lineHeight: 1.5, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" };

// Connect styles
const connectBlockStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, padding: "16px 18px", borderRadius: 14, border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)", background: "color-mix(in oklab, #ffffff 2%, transparent)", maxWidth: 640 };
const connectPathStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const cmdRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const connectOllamaStyle: CSSProperties = { ...faRowStyle, maxWidth: 640 };
