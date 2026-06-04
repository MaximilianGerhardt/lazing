'use client';

/**
 * Onboarding-Wizard (Phase AU.3).
 *
 * 6 Steps. Jeder Step ist persistiert via /api/onboarding/state, sodass
 * Refresh am korrekten Punkt re-rendert. State-Daten (Org-Wahl, Workspace-
 * ID, Claude-Max-Status) werden in users.onboarding_state.data abgelegt
 * und im Done-Step für den Auto-Redirect genutzt.
 */

import { useCallback, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import type { OnboardingState, OnboardingStep } from "@/lib/onboarding/state";
import { setOrgIdSilent, setWorkspaceId } from "@/lib/nav/hooks";

interface InitialUser {
  id: string;
  displayName: string;
  email: string;
}

interface OrgOption {
  id: string;
  name: string;
}

interface OnboardingClientProps {
  initial: {
    user: InitialUser;
    state: OnboardingState;
  };
}

const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: "Willkommen",
  profile: "Profil",
  organization: "Organisation",
  "first-workspace": "Erster Workspace",
  "claude-max": "Claude-MAX",
  done: "Los geht's",
};

export function OnboardingClient({
  initial,
}: OnboardingClientProps): React.JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initial.state.currentStep);
  const [data, setData] = useState<OnboardingState["data"]>(
    initial.state.data ?? {},
  );

  const [displayName, setDisplayName] = useState(initial.user.displayName);
  const [locale, setLocale] = useState<"de-DE" | "en-US">("de-DE");

  const [orgChoice, setOrgChoice] = useState<"solo" | "create" | "invite">(
    "create",
  );
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgType, setNewOrgType] = useState<
    "company" | "client" | "tool"
  >("company");

  const [wsLabel, setWsLabel] = useState("");
  const [wsSensitivity, setWsSensitivity] = useState<"low" | "normal" | "high">(
    "low",
  );
  const [wsOrgs, setWsOrgs] = useState<OrgOption[]>([]);
  const [wsOrgId, setWsOrgId] = useState<string>("");

  const [maxStatus, setMaxStatus] = useState<"shared" | "own">("shared");
  const [credentialsJson, setCredentialsJson] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (
      input: {
        step: OnboardingStep;
        completed?: boolean;
        displayName?: string;
        locale?: string;
        dataPatch?: OnboardingState["data"];
      },
    ): Promise<OnboardingState | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/onboarding/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error((j.error as string) ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as { state: OnboardingState };
        setStep(j.state.currentStep);
        if (j.state.data) setData(j.state.data);
        return j.state;
      } catch (err) {
        setError(err instanceof Error ? err.message : "unbekannt");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // --- Step Welcome ---
  const fromWelcome = (): void => {
    void patch({ step: "welcome", completed: true });
  };

  // --- Step Profile ---
  const fromProfile = (): void => {
    if (displayName.trim().length === 0) return;
    void patch({
      step: "profile",
      completed: true,
      displayName: displayName.trim(),
      locale,
    });
  };

  // --- Step Organization ---
  const fromOrganization = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let chosenOrgId: string | null = null;
      if (orgChoice === "create") {
        if (newOrgName.trim().length < 2) {
          setError("Org-Name zu kurz.");
          setBusy(false);
          return;
        }
        const res = await fetch("/api/orgs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: newOrgName.trim(),
            type: newOrgType,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error((j.error as string) ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as { org?: { id: string } };
        chosenOrgId = j.org?.id ?? null;
      }
      // solo + invite landen ohne neue Org → bleibt null, User ist
      // sowieso der Default-Org als Founder beigetreten (oder hat in
      // /orgs eine Bestehende-Mitgliedschaft).
      await patch({
        step: "organization",
        completed: true,
        dataPatch: { chosenOrgId },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "unbekannt");
    } finally {
      setBusy(false);
    }
  };

  // --- Step First-Workspace ---
  const loadOrgsForWs = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/orgs", { credentials: "same-origin" });
      const j = (await res.json()) as { orgs?: OrgOption[] };
      const list = Array.isArray(j.orgs) ? j.orgs : [];
      setWsOrgs(list);
      if (list.length > 0 && !wsOrgId) {
        // Default: bevorzuge die in vorigem Step erstellte Org, sonst erste.
        const preferred = data?.chosenOrgId ?? list[0].id;
        setWsOrgId(preferred);
      }
    } catch {
      /* ignore — fallback empty */
    }
  }, [data?.chosenOrgId, wsOrgId]);

  const fromFirstWorkspace = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let workspaceId: string | null = null;
      if (wsLabel.trim().length > 0 && wsOrgId) {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: wsLabel.trim(),
            sensitivity: wsSensitivity,
            organizationId: wsOrgId,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error((j.error as string) ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as { workspace?: { id: string } };
        workspaceId = j.workspace?.id ?? null;
        // Schreibe Org + Workspace sofort in localStorage damit der UI-State
        // (Badge, Segment, History) direkt den neuen Workspace zeigt —
        // unabhängig vom URL-Param im finish()-Redirect.
        // setOrgIdSilent: ohne hard-navigate (Wizard läuft weiter).
        // setWorkspaceId: umgeht findWorkspaceById-Guard (neuer WS noch nicht im Cache).
        if (workspaceId) {
          if (wsOrgId) setOrgIdSilent(wsOrgId);
          setWorkspaceId(workspaceId);
        }
      }
      await patch({
        step: "first-workspace",
        completed: true,
        dataPatch: { workspaceId },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "unbekannt");
    } finally {
      setBusy(false);
    }
  };

  const skipFirstWorkspace = (): void => {
    void patch({
      step: "first-workspace",
      completed: true,
      dataPatch: { workspaceId: null },
    });
  };

  // --- Step Claude-Max ---
  const fromClaudeMax = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (maxStatus === "own") {
        if (credentialsJson.trim().length < 30) {
          setError("credentials.json scheint leer/ungültig.");
          setBusy(false);
          return;
        }
        const res = await fetch("/api/users/me/claude-creds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credentialsJson: credentialsJson.trim() }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error((j.error as string) ?? `HTTP ${res.status}`);
        }
      } else {
        // shared — explizit setzen
        const res = await fetch("/api/users/me/claude-creds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "shared" }),
        });
        if (!res.ok) {
          // Tolerant: API-Default ist schon shared. Nur loggen.
          // eslint-disable-next-line no-console
          console.warn("[onboarding] shared-toggle API failed");
        }
      }
      await patch({
        step: "claude-max",
        completed: true,
        dataPatch: { claudeMaxStatus: maxStatus },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "unbekannt");
    } finally {
      setBusy(false);
    }
  };

  // --- Step Done ---
  const finish = async (): Promise<void> => {
    await patch({ step: "done", completed: true });
    const target = data?.workspaceId
      ? `/?workspace=${encodeURIComponent(data.workspaceId)}`
      : "/";
    router.push(target);
  };

  // --- Effect: Lade Orgs sobald wir auf first-workspace landen ---
  if (step === "first-workspace" && wsOrgs.length === 0 && !busy) {
    void loadOrgsForWs();
  }

  const stepIndex = (
    [
      "welcome",
      "profile",
      "organization",
      "first-workspace",
      "claude-max",
      "done",
    ] as OnboardingStep[]
  ).indexOf(step);

  return (
    <>
      <Glows />
      <div style={containerStyle} data-test="onboarding-root">
      <div style={stepperStyle} aria-label="Fortschritt">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            style={{
              ...dotStyle,
              background:
                i < stepIndex
                  ? "var(--a-now, #c9ff4d)"
                  : i === stepIndex
                    ? "color-mix(in oklab, var(--a-now, #c9ff4d) 80%, white)"
                    : "color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)",
            }}
            aria-hidden
          />
        ))}
      </div>
      <div style={crumbStyle}>
        Schritt {stepIndex + 1} / 6 · {STEP_TITLES[step]}
      </div>

      {step === "welcome" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Willkommen bei laz.ing.</h1>
          <p style={leadStyle}>
            laz.ing ist ein Multi-User-OS für deine Arbeit mit Claude Code und
            anderen KI-Agenten. Bevor wir loslegen, ein Blick auf das
            Datenmodell — das ist die wichtigste Idee, der ganze Rest baut
            darauf auf.
          </p>
          <DiagramBoxes />
          <p style={leadStyle}>
            Du bist <strong>User</strong>. Du gehörst zu einer oder mehreren{" "}
            <strong>Organisationen</strong>. Eine Organisation ist dein
            Geschäfts-Container — sie verwaltet <em>Mitglieder</em>{" "}
            <strong>UND</strong> <em>Workspaces</em>. Ein{" "}
            <strong>Workspace</strong> ist ein Projekt oder ein Kunde mit
            eigenem Chat, eigenen Tickets, eigenen Dateien.
          </p>
          <p style={leadStyle}>
            Wenn du deine drei Lieblings-Kunden in laz.ing hast, sind das drei
            Workspaces unter einer einzigen Org (deine Agentur).
          </p>
          <button
            type="button"
            onClick={fromWelcome}
            disabled={busy}
            style={ctaStyle}
          >
            Verstanden — los geht's
          </button>
        </section>
      ) : null}

      {step === "profile" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Wie sollen wir dich nennen?</h1>
          <p style={leadStyle}>
            Eingeloggt als <strong>{initial.user.email}</strong>. Den Anzeige-
            Namen sehen andere Mitglieder deiner Org.
          </p>
          <label style={labelStyle}>Anzeige-Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Max Mustermann"
            maxLength={80}
            style={inputStyle}
            disabled={busy}
          />
          <label style={{ ...labelStyle, marginTop: 16 }}>Sprache</label>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as "de-DE" | "en-US")}
            style={selectStyle}
            disabled={busy}
          >
            <option value="de-DE">Deutsch (Deutschland)</option>
            <option value="en-US">English (US)</option>
          </select>
          <button
            type="button"
            onClick={fromProfile}
            disabled={busy || displayName.trim().length === 0}
            style={ctaStyle}
          >
            Weiter
          </button>
        </section>
      ) : null}

      {step === "organization" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Organisation</h1>
          <p style={leadStyle}>
            Eine Org bündelt deine Workspaces und (später) deine Team-
            Mitglieder. Du kannst jetzt eine eigene anlegen, im Solo-Modus
            bleiben (nur Default-Org), oder warten bis dich jemand einlädt.
          </p>
          <div style={radioGroupStyle}>
            <RadioCard
              checked={orgChoice === "create"}
              onChange={() => setOrgChoice("create")}
              title="Eigene Organisation anlegen"
              hint="Empfohlen für Selbständige + Agenturen. Du wirst Founder."
            />
            <RadioCard
              checked={orgChoice === "solo"}
              onChange={() => setOrgChoice("solo")}
              title="Solo / privat"
              hint="Nutze nur die Default-Org. Du kannst später jederzeit eine eigene anlegen."
            />
            <RadioCard
              checked={orgChoice === "invite"}
              onChange={() => setOrgChoice("invite")}
              title="Bestehender Org beitreten"
              hint="Du brauchst einen Invite-Link von einem Admin der Org per Email."
              disabled
            />
          </div>
          {orgChoice === "create" ? (
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>Org-Name</label>
              <input
                type="text"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="z.B. Maxwell Designs LLC"
                maxLength={120}
                style={inputStyle}
                disabled={busy}
              />
              <label style={{ ...labelStyle, marginTop: 12 }}>Typ</label>
              <select
                value={newOrgType}
                onChange={(e) =>
                  setNewOrgType(e.target.value as "company" | "client" | "tool")
                }
                style={selectStyle}
                disabled={busy}
              >
                <option value="company">Company (eigene Firma/Agentur)</option>
                <option value="client">Client (Kunde unter einer Holding)</option>
                <option value="tool">Tool (eigenes Werkzeug/Produkt)</option>
              </select>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void fromOrganization()}
            disabled={
              busy ||
              (orgChoice === "create" && newOrgName.trim().length < 2) ||
              orgChoice === "invite"
            }
            style={ctaStyle}
          >
            Weiter
          </button>
        </section>
      ) : null}

      {step === "first-workspace" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Erster Workspace</h1>
          <p style={leadStyle}>
            Ein Workspace ist ein Projekt, ein Kunde, ein Bereich. Jeder
            Workspace hat eigenen Chat, eigene Tickets, eigene Files. Du
            kannst beliebig viele anlegen — der erste hilft dir, das Gefühl zu
            bekommen.
          </p>
          <label style={labelStyle}>Name</label>
          <input
            type="text"
            value={wsLabel}
            onChange={(e) => setWsLabel(e.target.value)}
            placeholder="z.B. acme-website oder Mein erster Auftrag"
            maxLength={120}
            style={inputStyle}
            disabled={busy}
          />
          <label style={{ ...labelStyle, marginTop: 12 }}>Organisation</label>
          <select
            value={wsOrgId}
            onChange={(e) => setWsOrgId(e.target.value)}
            style={selectStyle}
            disabled={busy || wsOrgs.length === 0}
          >
            {wsOrgs.length === 0 ? (
              <option value="">— lädt … —</option>
            ) : null}
            {wsOrgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <label style={{ ...labelStyle, marginTop: 12 }}>Sensitivity</label>
          <select
            value={wsSensitivity}
            onChange={(e) =>
              setWsSensitivity(e.target.value as "low" | "normal" | "high")
            }
            style={selectStyle}
            disabled={busy}
          >
            <option value="low">low — Standard</option>
            <option value="normal">normal — Kunde / Projekt</option>
            <option value="high">high — privat / sensibel</option>
          </select>
          <div style={btnRowStyle}>
            <button
              type="button"
              onClick={() => void fromFirstWorkspace()}
              disabled={busy || wsLabel.trim().length === 0 || !wsOrgId}
              style={ctaStyle}
            >
              Workspace anlegen
            </button>
            <button
              type="button"
              onClick={skipFirstWorkspace}
              disabled={busy}
              style={skipBtnStyle}
            >
              Später anlegen
            </button>
          </div>
        </section>
      ) : null}

      {step === "claude-max" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Claude-MAX-Plan</h1>
          <p style={leadStyle}>
            laz.ing spawnt für dich Claude-Code-CLI-Sessions — die brauchen
            einen Token. Zwei Optionen:
          </p>
          <div style={radioGroupStyle}>
            <RadioCard
              checked={maxStatus === "shared"}
              onChange={() => setMaxStatus("shared")}
              title="System-Token nutzen (empfohlen)"
              hint="Du teilst dir den Server-MAX-Plan. Einfach, sofort einsatzbereit. Limits sind shared — bei Multi-User wird das eng."
            />
            <RadioCard
              checked={maxStatus === "own"}
              onChange={() => setMaxStatus("own")}
              title="Eigenen MAX-Plan koppeln"
              hint="Du lädst deine eigene credentials.json hoch. Encrypted at rest. Eigene TPM-Quota, deine Spawns, dein Konto."
            />
          </div>
          {maxStatus === "own" ? (
            <div style={{ marginTop: 12 }}>
              <details style={detailsStyle}>
                <summary style={summaryStyle}>
                  So bekommst du deine credentials.json
                </summary>
                <ol style={olStyle}>
                  <li>
                    Auf deinem Rechner: <code>claude login</code> in der CLI
                    ausführen.
                  </li>
                  <li>
                    Die Datei <code>~/.claude/.credentials.json</code> öffnen.
                  </li>
                  <li>Inhalt komplett kopieren und unten einfügen.</li>
                </ol>
                <p style={detailsHintStyle}>
                  Wir verschlüsseln den Inhalt sofort (AES-256-GCM) und legen
                  ihn unter <code>~/.lazyos/user-creds/&lt;userId&gt;/</code> ab.
                  Klartext verlässt den Server nie.
                </p>
              </details>
              <label style={{ ...labelStyle, marginTop: 12 }}>
                credentials.json (Inhalt einfügen)
              </label>
              <textarea
                value={credentialsJson}
                onChange={(e) => setCredentialsJson(e.target.value)}
                placeholder={'{"oauthAccount": {...}, "access_token": "..."}'}
                style={textareaStyle}
                rows={6}
                disabled={busy}
                spellCheck={false}
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void fromClaudeMax()}
            disabled={
              busy ||
              (maxStatus === "own" && credentialsJson.trim().length < 30)
            }
            style={ctaStyle}
          >
            Weiter
          </button>
        </section>
      ) : null}

      {step === "done" ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Alles bereit, {displayName}.</h1>
          <p style={leadStyle}>
            Dein Account ist eingerichtet. Wir landen dich gleich im Chat
            {data?.workspaceId
              ? ` deines neuen Workspaces.`
              : ` der Default-Org.`}
          </p>
          <ul style={summaryListStyle}>
            <li>
              Account: <strong>{displayName}</strong> ({initial.user.email})
            </li>
            <li>
              Org:{" "}
              <strong>
                {data?.chosenOrgId ? data.chosenOrgId : "Default (workspace)"}
              </strong>
            </li>
            <li>
              Workspace:{" "}
              <strong>{data?.workspaceId ?? "wird beim ersten Chat erstellt"}</strong>
            </li>
            <li>
              Claude-MAX:{" "}
              <strong>
                {data?.claudeMaxStatus === "own" ? "eigener Plan" : "System-Token"}
              </strong>
            </li>
          </ul>
          <button type="button" onClick={() => void finish()} disabled={busy} style={ctaStyle}>
            Zum Chat
          </button>
        </section>
      ) : null}

      {error ? (
        <div style={errorBoxStyle} role="alert">
          Fehler: {error}
        </div>
      ) : null}
      </div>
    </>
  );
}

function RadioCard({
  checked,
  onChange,
  title,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  hint: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      disabled={disabled}
      style={{
        ...radioCardStyle,
        borderColor: checked
          ? "var(--a-now, #c9ff4d)"
          : "color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)",
        background: checked
          ? "color-mix(in oklab, var(--a-now, #c9ff4d) 6%, transparent)"
          : "color-mix(in oklab, #ffffff 2%, transparent)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span
        style={{
          ...radioDotStyle,
          background: checked ? "var(--a-now, #c9ff4d)" : "transparent",
          borderColor: checked
            ? "var(--a-now, #c9ff4d)"
            : "color-mix(in oklab, var(--ink, #f5f5f5) 30%, transparent)",
        }}
        aria-hidden
      />
      <span style={radioLabelWrapStyle}>
        <span style={radioTitleStyle}>{title}</span>
        <span style={radioHintStyle}>{hint}</span>
      </span>
    </button>
  );
}

function DiagramBoxes(): React.JSX.Element {
  return (
    <div style={diagramWrapStyle} aria-hidden>
      <div style={diagramBoxStyle}>
        <div style={diagramTitleStyle}>User</div>
        <div style={diagramSubStyle}>du</div>
      </div>
      <div style={diagramArrowStyle}>→</div>
      <div style={diagramBoxStyle}>
        <div style={diagramTitleStyle}>Organisation</div>
        <div style={diagramSubStyle}>Geschäfts-Container</div>
      </div>
      <div style={diagramArrowStyle}>→</div>
      <div style={diagramBoxStyle}>
        <div style={diagramTitleStyle}>Workspaces</div>
        <div style={diagramSubStyle}>Projekte / Kunden (1..n)</div>
      </div>
    </div>
  );
}

/** Pitch-Black canvas atmosphere — 3 radiale Glows, identisch zu OssOnboardingClient. */
function Glows(): React.JSX.Element {
  return (
    <div aria-hidden style={glowWrapStyle}>
      <div
        style={{
          ...glowStyle,
          top: "-20%",
          left: "-10%",
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--a-now, #c9ff4d) 5%, transparent), transparent 70%)",
        }}
      />
      <div
        style={{
          ...glowStyle,
          bottom: "-30%",
          right: "-15%",
          background:
            "radial-gradient(closest-side, color-mix(in oklab, #6effe0 4%, transparent), transparent 70%)",
        }}
      />
      <div
        style={{
          ...glowStyle,
          top: "40%",
          right: "30%",
          background:
            "radial-gradient(closest-side, color-mix(in oklab, #ffffff 2.5%, transparent), transparent 70%)",
          width: 600,
          height: 600,
        }}
      />
    </div>
  );
}

const EASE = "cubic-bezier(0.25, 0.1, 0.25, 1)";
const T = `240ms ${EASE}`;

const glowWrapStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: 0,
  overflow: "hidden",
};

const glowStyle: CSSProperties = {
  position: "absolute",
  width: 720,
  height: 720,
  filter: "blur(40px)",
};

const containerStyle: CSSProperties = {
  maxWidth: 640,
  margin: "clamp(48px, 10vw, 128px) auto 96px",
  padding: "0 28px",
  position: "relative",
  zIndex: 1,
};

const stepperStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  marginBottom: 12,
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  display: "inline-block",
  transition: `background ${T}`,
};

const crumbStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 45%, transparent)",
  marginBottom: 40,
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(30px, 5vw, 44px)",
  fontWeight: 600,
  letterSpacing: "-0.025em",
  lineHeight: 1.05,
  margin: 0,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  color: "var(--ink, #f5f5f5)",
};

const leadStyle: CSSProperties = {
  fontSize: 17,
  lineHeight: 1.55,
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 75%, transparent)",
  margin: 0,
  maxWidth: 540,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono, ui-monospace)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)",
  marginBottom: 0,
};

const inputStyle: CSSProperties = {
  padding: "13px 16px",
  fontSize: 15,
  borderRadius: 10,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)",
  background: "color-mix(in oklab, #ffffff 2.5%, transparent)",
  color: "var(--ink, #f5f5f5)",
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  width: "100%",
  maxWidth: 480,
  boxSizing: "border-box",
  transition: `border-color ${T}, background ${T}`,
  outline: "none",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: "none",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  resize: "vertical",
};

const ctaStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  alignSelf: "flex-start",
  padding: "13px 24px",
  fontSize: 14,
  fontWeight: 500,
  borderRadius: 10,
  border: "none",
  background:
    "linear-gradient(135deg, var(--a-now, #c9ff4d) 0%, color-mix(in oklab, var(--a-now, #c9ff4d) 70%, #6effe0) 100%)",
  color: "#070707",
  cursor: "pointer",
  marginTop: 4,
  transition: `transform ${T}, opacity ${T}, filter ${T}`,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
};

const skipBtnStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "13px 20px",
  fontSize: 13,
  fontFamily: "var(--font-mono, ui-monospace)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  borderRadius: 10,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 10%, transparent)",
  background: "transparent",
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)",
  cursor: "pointer",
  marginTop: 4,
  transition: `border-color ${T}, color ${T}`,
};

const radioGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 540,
};

const btnRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  marginTop: 8,
};

const radioCardStyle: CSSProperties = {
  appearance: "none",
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "14px 16px",
  borderRadius: 12,
  border: "0.5px solid",
  textAlign: "left",
  width: "100%",
  transition: `background ${T}, border-color ${T}`,
  color: "var(--ink, #f5f5f5)",
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
};

const radioDotStyle: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 999,
  border: "1.5px solid",
  flexShrink: 0,
  marginTop: 4,
  transition: `background ${T}, border-color ${T}`,
};

const radioLabelWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const radioTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: "var(--ink, #f5f5f5)",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const radioHintStyle: CSSProperties = {
  fontSize: 13,
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 50%, transparent)",
  lineHeight: 1.5,
};

const diagramWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  margin: "12px 0",
};

const diagramBoxStyle: CSSProperties = {
  flex: "1 1 140px",
  minWidth: 140,
  padding: "16px 18px",
  borderRadius: 12,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 8%, transparent)",
  background: "color-mix(in oklab, #ffffff 2%, transparent)",
};

const diagramTitleStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--a-now, #c9ff4d)",
};

const diagramSubStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 60%, transparent)",
};

const diagramArrowStyle: CSSProperties = {
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 35%, transparent)",
  fontSize: 18,
  fontFamily: "var(--font-mono, ui-monospace)",
};

const detailsStyle: CSSProperties = {
  border: "0.5px dashed color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)",
  borderRadius: 10,
  padding: "10px 14px",
  background: "color-mix(in oklab, #ffffff 2%, transparent)",
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  fontFamily: "var(--font-mono, ui-monospace)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 55%, transparent)",
};

const olStyle: CSSProperties = {
  margin: "12px 0 0",
  paddingLeft: 18,
  fontSize: 13,
  lineHeight: 1.6,
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 65%, transparent)",
};

const detailsHintStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "color-mix(in oklab, var(--ink, #f5f5f5) 45%, transparent)",
  lineHeight: 1.55,
};

const summaryListStyle: CSSProperties = {
  margin: "8px 0 0",
  padding: 0,
  listStyle: "none",
  fontSize: 14,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: 480,
};

const errorBoxStyle: CSSProperties = {
  marginTop: 24,
  padding: "12px 16px",
  borderRadius: 10,
  background: "color-mix(in oklab, #ff6464 12%, transparent)",
  border: "0.5px solid color-mix(in oklab, #ff6464 30%, transparent)",
  color: "color-mix(in oklab, #ff8888 90%, white)",
  fontSize: 13,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  maxWidth: 540,
};
