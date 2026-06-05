"use client";

/**
 * Phase AU.1.1 — magic-link-first login.
 *
 * Default form: email + "send login link". POST /api/auth/magic/issue.
 *
 * Operator bootstrap section (collapsible): email + display name + access code.
 * Only shown when /api/auth/bootstrap-status returns `available=true`
 * (LAZYOS_ACCESS_CODE set AND the DB has no founder yet).
 *
 * After a successful bootstrap → redirect /onboarding.
 * After a successful magic mail → inline success "mail on its way to xx@yy.zz".
 */

import { useEffect, useState, useTransition, type CSSProperties } from "react";

interface LoginFormProps {
  from: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm({ from }: LoginFormProps): React.JSX.Element {
  // Magic-link state
  const [email, setEmail] = useState("");
  const [magicSent, setMagicSent] = useState<string | null>(null);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicPending, startMagicTransition] = useTransition();

  // Bootstrap state
  const [bootstrapAvailable, setBootstrapAvailable] = useState<boolean | null>(
    null,
  );
  // Codeless first-run (localhost): the local operator is the owner — one click,
  // no access code, no terminal.
  const [codeless, setCodeless] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [getName, setGetName] = useState("");
  const [getError, setGetError] = useState<string | null>(null);
  const [getPending, startGetTransition] = useTransition();
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [bootEmail, setBootEmail] = useState("");
  const [bootName, setBootName] = useState("");
  const [bootCode, setBootCode] = useState("");
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootPending, startBootTransition] = useTransition();

  // Master-login state (solo self-host, WITHOUT mail)
  const [masterAvailable, setMasterAvailable] = useState<boolean>(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [masterCode, setMasterCode] = useState("");
  const [masterError, setMasterError] = useState<string | null>(null);
  const [masterPending, startMasterTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/bootstrap-status", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then(
        (data: {
          available?: boolean;
          codeless?: boolean;
          masterLoginAvailable?: boolean;
        }) => {
          if (cancelled) return;
          setBootstrapAvailable(data.available === true);
          setCodeless(data.codeless === true);
          setMasterAvailable(data.masterLoginAvailable === true);
        },
      )
      .catch(() => {
        if (!cancelled) setBootstrapAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submitMagic = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setMagicError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setMagicError("Please enter a valid email address.");
      return;
    }
    startMagicTransition(async () => {
      try {
        const res = await fetch("/api/auth/magic/issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email: email.trim(), intent: "login" }),
        });
        if (res.status === 429) {
          setMagicError("Too many attempts. Please wait a moment.");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setMagicError(body.error ?? "Sending failed.");
          return;
        }
        // DEV AUTO-LOGIN (2026-05-23): if the server returns
        // `autoLoginUsed=true` → NO mail sent, the session cookie is already
        // set, redirect directly.
        const json = (await res.json().catch(() => ({}))) as {
          autoLoginUsed?: boolean;
          redirectTo?: string;
        };
        if (json.autoLoginUsed === true) {
          window.location.href = json.redirectTo ?? from;
          return;
        }
        setMagicSent(email.trim());
      } catch (err) {
        setMagicError(
          "Network error: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  };

  // Codeless first-run: one click, no access code (localhost only — the server
  // enforces loopback). E-mail/name fall back to server defaults if left blank.
  const submitCodeless = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setGetError(null);
    startGetTransition(async () => {
      try {
        const res = await fetch("/api/auth/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(
            getName.trim().length > 0 ? { displayName: getName.trim() } : {},
          ),
        });
        if (res.status === 410) {
          setGetError("Already set up — use the sign-in options below.");
          setCodeless(false);
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setGetError(j.error ?? "Setup failed.");
          return;
        }
        const body = (await res.json()) as { redirectTo?: string };
        window.location.href = body.redirectTo ?? from;
      } catch (err) {
        setGetError(
          "Network error: " + (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  };

  const submitBootstrap = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setBootError(null);
    if (!EMAIL_RE.test(bootEmail.trim())) {
      setBootError("Please enter a valid email.");
      return;
    }
    if (bootName.trim().length === 0) {
      setBootError("Display name is required.");
      return;
    }
    if (bootCode.trim().length < 16) {
      setBootError("Access code too short (at least 16 characters).");
      return;
    }
    startBootTransition(async () => {
      try {
        const res = await fetch("/api/auth/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email: bootEmail.trim(),
            displayName: bootName.trim(),
            accessCode: bootCode,
          }),
        });
        if (res.status === 410) {
          setBootError(
            "Bootstrap is already complete — use the email login above.",
          );
          setBootstrapAvailable(false);
          return;
        }
        if (res.status === 401) {
          setBootError("Access code is incorrect.");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setBootError(body.error ?? "Bootstrap failed.");
          return;
        }
        const body = (await res.json()) as { redirectTo?: string };
        window.location.href = body.redirectTo ?? from;
      } catch (err) {
        setBootError(
          "Network error: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  };

  const submitMaster = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setMasterError(null);
    if (masterCode.trim().length < 16) {
      setMasterError("Access code too short (at least 16 characters).");
      return;
    }
    startMasterTransition(async () => {
      try {
        const res = await fetch("/api/auth/master-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ accessCode: masterCode }),
        });
        if (res.status === 401) {
          setMasterError("Access code is incorrect.");
          return;
        }
        if (res.status === 503) {
          setMasterError("Master login disabled (no code set).");
          return;
        }
        if (res.status === 409) {
          setMasterError(
            "No founder exists yet — use the operator bootstrap instead.",
          );
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setMasterError(j.error ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as { redirectTo?: string };
        window.location.href = body.redirectTo ?? from;
      } catch (err) {
        setMasterError(
          "Network error: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  };

  if (magicSent) {
    return (
      <div style={successWrapStyle}>
        <div style={successPillStyle}>Mail on its way</div>
        <p style={successTextStyle}>
          We sent a login link to{" "}
          <strong style={{ color: "var(--ink)" }}>{magicSent}</strong>.{" "}
          Click the link in the email to log in.
        </p>
        <p style={successHintStyle}>
          No email? Check your spam folder. The link expires in 30 minutes.
        </p>
        <button
          type="button"
          onClick={() => {
            setMagicSent(null);
            setEmail("");
          }}
          style={linkBtnStyle}
        >
          ← use a different email
        </button>
      </div>
    );
  }

  return (
    <div>
      {codeless && !magicSent ? (
        <form onSubmit={submitCodeless} noValidate style={{ marginBottom: 4 }}>
          <p style={{ ...bootHintStyle, marginBottom: 16 }}>
            You&apos;re setting up laz.ing on this machine — so you&apos;re the
            owner. No code needed.
          </p>
          <label htmlFor="get-name" style={labelStyle}>
            Your name (optional)
          </label>
          <input
            id="get-name"
            name="get-name"
            type="text"
            autoComplete="name"
            autoFocus
            disabled={getPending}
            value={getName}
            onChange={(e) => setGetName(e.target.value)}
            placeholder="Owner"
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={getPending}
            style={primaryBtnStyle(getPending, false)}
          >
            {getPending ? "Setting up…" : "Get started →"}
          </button>
          {getError ? (
            <p role="alert" style={errorStyle}>
              {getError}
            </p>
          ) : null}
        </form>
      ) : null}

      {codeless && !magicSent ? (
        <div style={dividerStyle}>
          <button
            type="button"
            onClick={() => setOtherOpen((v) => !v)}
            style={collapsibleBtnStyle}
          >
            {otherOpen
              ? "Hide other sign-in options"
              : "→ Other ways to sign in (email / access code)"}
          </button>
        </div>
      ) : null}

      {!codeless || otherOpen ? (
      <>
      <form onSubmit={submitMagic} noValidate>
        <label htmlFor="login-email" style={labelStyle}>
          Email address
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          disabled={magicPending}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your.name@example.com"
          style={inputStyle}
        />
        <button
          type="submit"
          disabled={magicPending || email.length === 0}
          style={primaryBtnStyle(magicPending, email.length === 0)}
        >
          {magicPending ? "Sending…" : "Send login link by email"}
        </button>
        {magicError ? (
          <p role="alert" style={errorStyle}>
            {magicError}
          </p>
        ) : null}
      </form>

      {bootstrapAvailable && !codeless ? (
        <div style={dividerStyle}>
          <button
            type="button"
            onClick={() => setBootstrapOpen((v) => !v)}
            style={collapsibleBtnStyle}
          >
            {bootstrapOpen
              ? "Close operator bootstrap"
              : "→ First install: operator bootstrap"}
          </button>
          {bootstrapOpen ? (
            <form onSubmit={submitBootstrap} noValidate style={bootFormStyle}>
              <p style={bootHintStyle}>
                This instance has no founder user yet. Create the first user now.
                We use your{" "}
                <code>LAZYOS_ACCESS_CODE</code> as a one-time confirmation.
              </p>
              <label htmlFor="boot-email" style={labelStyle}>
                Email
              </label>
              <input
                id="boot-email"
                name="boot-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                disabled={bootPending}
                value={bootEmail}
                onChange={(e) => setBootEmail(e.target.value)}
                placeholder="founder@example.com"
                style={inputStyle}
              />
              <label
                htmlFor="boot-name"
                style={{ ...labelStyle, marginTop: 12 }}
              >
                Display name
              </label>
              <input
                id="boot-name"
                name="boot-name"
                type="text"
                autoComplete="name"
                required
                disabled={bootPending}
                value={bootName}
                onChange={(e) => setBootName(e.target.value)}
                placeholder="Jane Doe"
                style={inputStyle}
              />
              <label
                htmlFor="boot-code"
                style={{ ...labelStyle, marginTop: 12 }}
              >
                Access code
              </label>
              <input
                id="boot-code"
                name="boot-code"
                type="password"
                autoComplete="off"
                required
                disabled={bootPending}
                value={bootCode}
                onChange={(e) => setBootCode(e.target.value)}
                style={inputStyle}
              />
              <button
                type="submit"
                disabled={bootPending}
                style={{ ...primaryBtnStyle(bootPending, false), marginTop: 16 }}
              >
                {bootPending ? "Creating…" : "Create founder account"}
              </button>
              {bootError ? (
                <p role="alert" style={errorStyle}>
                  {bootError}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}

      {masterAvailable ? (
        <div style={dividerStyle}>
          <button
            type="button"
            onClick={() => setMasterOpen((v) => !v)}
            style={collapsibleBtnStyle}
          >
            {masterOpen
              ? "Close master-code login"
              : "→ Solo self-host: log in with a master code"}
          </button>
          {masterOpen ? (
            <form onSubmit={submitMaster} noValidate style={bootFormStyle}>
              <p style={bootHintStyle}>
                If you are the operator of this instance (i.e. you know{" "}
                <code>LAZYOS_ACCESS_CODE</code>), you can log in directly as the
                founder — without email. Useful for solo self-host or when Resend
                is temporarily unreachable.
              </p>
              <label htmlFor="master-code" style={labelStyle}>
                Master access code
              </label>
              <input
                id="master-code"
                name="master-code"
                type="password"
                autoComplete="off"
                required
                disabled={masterPending}
                value={masterCode}
                onChange={(e) => setMasterCode(e.target.value)}
                style={inputStyle}
              />
              <button
                type="submit"
                disabled={masterPending}
                style={{
                  ...primaryBtnStyle(masterPending, false),
                  marginTop: 16,
                }}
              >
                {masterPending ? "Logging in…" : "Log in as founder"}
              </button>
              {masterError ? (
                <p role="alert" style={errorStyle}>
                  {masterError}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
      </>
      ) : null}
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: "var(--ink-2)",
  marginBottom: 8,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  fontSize: 14,
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
  background: "var(--sheet-3)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 10,
  outline: "none",
  boxSizing: "border-box",
};

function primaryBtnStyle(pending: boolean, disabled: boolean): CSSProperties {
  return {
    width: "100%",
    marginTop: 16,
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 500,
    color: "var(--screen)",
    background: "var(--primary)",
    border: "none",
    borderRadius: 10,
    cursor: pending ? "progress" : "pointer",
    opacity: pending || disabled ? 0.6 : 1,
    transition: "opacity 120ms ease",
  };
}

const errorStyle: CSSProperties = {
  marginTop: 14,
  marginBottom: 0,
  fontSize: 13,
  color: "var(--a-danger)",
};

const dividerStyle: CSSProperties = {
  marginTop: 32,
  paddingTop: 20,
  borderTop: "0.5px dashed var(--line-2)",
};

const collapsibleBtnStyle: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  padding: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  cursor: "pointer",
};

const bootFormStyle: CSSProperties = {
  marginTop: 16,
};

const bootHintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--ink-3)",
  marginTop: 0,
  marginBottom: 16,
};

const successWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  alignItems: "flex-start",
};

const successPillStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  padding: "4px 10px",
  borderRadius: 999,
  border: "0.5px solid var(--a-clientb)",
  color: "var(--a-clientb)",
};

const successTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--ink-2)",
};

const successHintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--ink-3)",
};

const linkBtnStyle: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  padding: 0,
  marginTop: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  cursor: "pointer",
};
