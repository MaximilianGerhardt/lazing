/**
 * Tests für /lab PII-Redaction (MVP, 2026-05-01).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  REDACTED_EMAIL,
  REDACTED_IBAN,
  REDACTED_PHONE,
  REDACTED_VAT,
  redactPayload,
  redactPii,
  redactWorkspaceLabel,
  truncateTitle,
} from "../redact";

test("redactPii: ersetzt einfache E-Mail-Adresse", () => {
  const out = redactPii("Kontakt: max@example.com bitte!");
  assert.equal(out, `Kontakt: ${REDACTED_EMAIL} bitte!`);
});

test("redactPii: ersetzt deutsche Telefonnummer mit Vorwahl", () => {
  const out = redactPii("Ruf an: +49 341 8616297 sofort");
  assert.ok(out.includes(REDACTED_PHONE), `expected phone redacted, got: ${out}`);
  assert.ok(!out.includes("8616297"));
});

test("redactPii: ersetzt IBAN", () => {
  const out = redactPii("IBAN DE89370400440532013000 ist die Hauskasse");
  assert.ok(out.includes(REDACTED_IBAN), `expected IBAN redacted, got: ${out}`);
  assert.ok(!out.includes("DE89370400440532013000"));
});

test("redactPii: ersetzt USt-ID", () => {
  const out = redactPii("USt-ID DE123456789 vom Dienstleister");
  assert.ok(out.includes(REDACTED_VAT), `expected VAT redacted, got: ${out}`);
  assert.ok(!out.includes("DE123456789"));
});

test("redactPii: kombiniert mehrere Patterns in einem Satz", () => {
  const input =
    "Mail max@example.com, Tel +49 341 1234567, IBAN DE89370400440532013000, USt DE123456789";
  const out = redactPii(input);
  assert.ok(out.includes(REDACTED_EMAIL));
  assert.ok(out.includes(REDACTED_PHONE));
  assert.ok(out.includes(REDACTED_IBAN));
  assert.ok(out.includes(REDACTED_VAT));
});

test("redactPii: lässt Whitespace und harmlose Strings unverändert", () => {
  assert.equal(redactPii("   "), "   ");
  assert.equal(redactPii("Hello world"), "Hello world");
  assert.equal(redactPii(""), "");
});

test("redactWorkspaceLabel: lässt Whitelist-Labels durch", () => {
  assert.equal(redactWorkspaceLabel("Demo Fitness Fitness", 1), "Demo Fitness Fitness");
  assert.equal(redactWorkspaceLabel("Demo PV", 2), "Demo PV");
  assert.equal(redactWorkspaceLabel("lazyOS", 3), "lazyOS");
});

test("redactWorkspaceLabel: pseudonymisiert unbekannte Labels", () => {
  assert.equal(redactWorkspaceLabel("Some-Private-Label", 0), "Workspace #0");
  assert.equal(redactWorkspaceLabel("private-vault", 7), "Workspace #7");
});

test("truncateTitle: kürzt zu lange Titel", () => {
  const long = "A".repeat(100);
  const out = truncateTitle(long, 80);
  assert.equal(out.length, 80);
  assert.ok(out.endsWith("…"));
});

test("redactPayload: rekursiv durch nested objects", () => {
  const input = {
    title: "Anruf bei max@example.com wegen IBAN DE89370400440532013000",
    nested: {
      phone: "+49 341 8616297",
      list: ["clean", "max@example.com"],
    },
    n: 42,
    flag: true,
    nullable: null,
  };
  const out = redactPayload(input) as Record<string, unknown>;
  const title = out.title as string;
  assert.ok(title.includes(REDACTED_EMAIL));
  assert.ok(title.includes(REDACTED_IBAN));
  const nested = out.nested as Record<string, unknown>;
  assert.ok((nested.phone as string).includes(REDACTED_PHONE));
  const list = nested.list as unknown[];
  assert.equal(list[0], "clean");
  assert.ok((list[1] as string).includes(REDACTED_EMAIL));
  assert.equal(out.n, 42);
  assert.equal(out.flag, true);
  assert.equal(out.nullable, null);
});

test("redactPayload: title-Felder werden auf 80 chars truncated", () => {
  const longTitle = "B".repeat(200);
  const out = redactPayload({ title: longTitle }) as { title: string };
  assert.equal(out.title.length, 80);
  assert.ok(out.title.endsWith("…"));
});
