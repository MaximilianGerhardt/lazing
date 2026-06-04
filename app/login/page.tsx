import { Suspense } from "react";

import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

/**
 * Login page — Magic-Link-First (Phase AU.1.1).
 *
 * Server wrapper so we can set a minimal no-chrome layout and read
 * the `?from=` redirect target on the server. The form itself is a
 * client component for the submit flow + Bootstrap-Status-Probe.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const params = await searchParams;
  const fromRaw = params.from;
  // Only accept same-site paths — never open redirects.
  const from =
    typeof fromRaw === "string" && fromRaw.startsWith("/") && !fromRaw.startsWith("//")
      ? fromRaw
      : "/";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        background: "var(--screen)",
      }}
    >
      <section
        aria-labelledby="login-heading"
        style={{
          width: "100%",
          maxWidth: 360,
          padding: "32px 28px",
          border: "1px solid var(--line)",
          borderRadius: 16,
          background: "var(--sheet-2)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <h1
          id="login-heading"
          style={{
            margin: 0,
            marginBottom: 6,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: "var(--ink)",
          }}
        >
          laz.ing
        </h1>
        <p
          style={{
            margin: 0,
            marginBottom: 24,
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          Enter your email and a login link will arrive by mail.
        </p>
        <Suspense fallback={null}>
          <LoginForm from={from} />
        </Suspense>
      </section>
    </main>
  );
}
