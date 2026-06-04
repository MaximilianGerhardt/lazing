'use client';

/**
 * FormPromptCard — Generic <surface:form>
 * ----------------------------------------
 * Sub-Plan C (2026-04-29). Render surface for arbitrary structured
 * inputs (completing org data, briefing answers, onboarding steps).
 * The schema comes from the LLM:
 *
 *   <surface:form>{
 *     "title": "Org-Daten ergaenzen",
 *     "subtitle": "Diese Daten landen unter /orgs/{id}/branding",
 *     "endpoint": {"method":"PATCH","url":"/api/orgs/01ABC.../"},
 *     "successMessage": "Org-Daten gespeichert.",
 *     "fields": [
 *       {"name":"legalName","label":"Rechtsname","type":"text","required":true},
 *       {"name":"vatId","label":"USt-IdNr.","type":"text","pattern":"^[A-Z]{2}\\d+$"},
 *       {"name":"addressLines","label":"Adresse","type":"textarea","rows":4}
 *     ]
 *   }</surface:form>
 *
 * Security:
 *   - Endpoint whitelist: the url must start with `/api/`, method ∈ PATCH|POST.
 *     Otherwise silent reject + error toast inline. No arbitrary-URL submit.
 *   - Sensitive fields (sensitive=true): render as type=password and
 *     their values are NOT echoed in `reply()` (field name only).
 *
 * Render strategy:
 *   - Layout analogous to CredentialPromptCard.tsx (card frame, --sheet-2 + 0.5px
 *     border, --a-now as primary).
 *   - Validation client-side: required, pattern, minLength, maxLength.
 *     First check on submit, errors as small pills under the fields.
 *   - Submit: fetch(endpoint.url, method=endpoint.method, JSON body).
 *     Success -> reply(successMessage), done state.
 *     4xx/5xx -> inline error, no crash.
 *
 * Pure helpers (validateFormValues, isEndpointAllowed, sanitizeReplyValues)
 * are exported + unit-testable without a DOM.
 */

import { useState, type ChangeEvent } from 'react';

import { useSurfaceAction } from './SurfaceActionContext';

// Wave 4.3 (2026-05-01): inline styles → CSS classes `.srf-form__*` (token bind).

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'number'
  | 'url'
  | 'select'
  | 'color'
  | 'password';

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  helper?: string;
  options?: FormFieldOption[];
  /** Sensitive: render type=password und nicht in reply()-Echo. */
  sensitive?: boolean;
}

export interface FormEndpoint {
  method: 'PATCH' | 'POST';
  url: string;
}

export interface FormSchema {
  title: string;
  subtitle?: string;
  endpoint: FormEndpoint;
  successMessage?: string;
  fields: FormField[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Endpoint whitelist:
 *   - method ∈ {PATCH, POST}
 *   - url MUST start with "/api/" (relative paths only — no external
 *     origins, no protocol-relative `//evil.com`, no file:, no data:)
 *
 * Deliberately strict. If an LLM emits a form with endpoint.url = "https://evil.com",
 * we drop it without submitting.
 */
export function isEndpointAllowed(ep: FormEndpoint | undefined): boolean {
  if (!ep) return false;
  if (ep.method !== 'PATCH' && ep.method !== 'POST') return false;
  if (typeof ep.url !== 'string') return false;
  if (!ep.url.startsWith('/api/')) return false;
  // Defense-in-depth: no double slash, no whitespace
  if (ep.url.startsWith('//')) return false;
  if (/\s/.test(ep.url)) return false;
  return true;
}

/**
 * Validation pass over all fields. Returns Map<fieldName, errorMessage>
 * or an empty map if everything is ok.
 *
 * Validation order per field:
 *   1. required + empty -> "Pflichtfeld"
 *   2. minLength        -> "Mindestens N Zeichen"
 *   3. maxLength        -> "Maximal N Zeichen"
 *   4. pattern          -> "Ungueltiges Format"
 *   5. type=email       -> primitive email-shape check
 *   6. type=url         -> primitive url-shape check
 *   7. type=number      -> Number.isFinite
 *
 * Faulty regex patterns (TypeError from new RegExp) are defensively
 * swallowed — we show "Ungueltiges Format" instead of crashing.
 */
export function validateFormValues(
  fields: FormField[],
  values: Record<string, string>,
): Map<string, string> {
  const errors = new Map<string, string>();
  for (const f of fields) {
    const raw = values[f.name] ?? '';
    const v = raw.trim();
    if (f.required && v.length === 0) {
      errors.set(f.name, 'Pflichtfeld');
      continue;
    }
    // Optional + empty = do not check further (otherwise the pattern triggers on '').
    if (v.length === 0) continue;
    if (typeof f.minLength === 'number' && v.length < f.minLength) {
      errors.set(f.name, `Mindestens ${f.minLength} Zeichen`);
      continue;
    }
    if (typeof f.maxLength === 'number' && v.length > f.maxLength) {
      errors.set(f.name, `Maximal ${f.maxLength} Zeichen`);
      continue;
    }
    if (typeof f.pattern === 'string' && f.pattern.length > 0) {
      try {
        const re = new RegExp(f.pattern);
        if (!re.test(v)) {
          errors.set(f.name, 'Ungültiges Format');
          continue;
        }
      } catch {
        errors.set(f.name, 'Ungültiges Format');
        continue;
      }
    }
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      errors.set(f.name, 'Bitte eine gültige E-Mail');
      continue;
    }
    if (f.type === 'url') {
      try {
        // The URL constructor throws on broken URLs.
        // base-url "http://x" so relative URLs are not accepted? No —
        // we want absolute URLs here; without a base, URL throws for "foo".
        new URL(v);
      } catch {
        errors.set(f.name, 'Bitte eine gültige URL');
        continue;
      }
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.set(f.name, 'Bitte eine Zahl');
        continue;
      }
    }
  }
  return errors;
}

/**
 * Sensitive-aware reply sanitizer. If a field is `sensitive=true`,
 * its value is replaced by "<gespeichert>" — the actual plaintext
 * lands neither in the chat log nor in the server echo.
 *
 * Output: a pre-formatted reply string that can be read by the LLM
 * ("Feld X = Wert / Feld Y = <gespeichert>"). No JSON — we want
 * the bubble to be readable.
 */
export function sanitizeReplyValues(
  fields: FormField[],
  values: Record<string, string>,
): { values: Record<string, string>; reply: string } {
  const safe: Record<string, string> = {};
  const lines: string[] = [];
  for (const f of fields) {
    const raw = values[f.name] ?? '';
    if (f.sensitive === true) {
      safe[f.name] = '<gespeichert>';
      lines.push(`${f.label}: <gespeichert>`);
    } else {
      safe[f.name] = raw;
      lines.push(`${f.label}: ${raw}`);
    }
  }
  return { values: safe, reply: lines.join('\n') };
}

/**
 * Schema-Validierung (vor dem Render). Liefert null wenn ok, sonst eine
 * Fehler-Beschreibung warum das Schema verworfen werden sollte.
 */
export function validateFormSchema(schema: FormSchema | null): string | null {
  if (!schema) return 'Schema fehlt';
  if (typeof schema.title !== 'string' || schema.title.length === 0) {
    return 'title fehlt';
  }
  if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
    return 'fields fehlt';
  }
  if (!isEndpointAllowed(schema.endpoint)) {
    return 'Endpoint nicht erlaubt';
  }
  for (const f of schema.fields) {
    if (typeof f.name !== 'string' || f.name.length === 0) return 'field.name fehlt';
    if (typeof f.label !== 'string' || f.label.length === 0) return 'field.label fehlt';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  schema: FormSchema;
}

export function FormPromptCard({ schema }: Props): React.JSX.Element {
  const { reply } = useSurfaceAction();
  // Init values: pre-filled from options (select), otherwise empty.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of schema.fields) {
      if (f.type === 'select' && Array.isArray(f.options) && f.options.length > 0) {
        init[f.name] = f.options[0].value;
      } else {
        init[f.name] = '';
      }
    }
    return init;
  });
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Pre-render schema check. Should never actually fire because renderForm
  // already filters in the SurfaceRenderer — defensive belt-and-suspenders.
  const schemaErr = validateFormSchema(schema);
  if (schemaErr) {
    return (
      <article
        className="srf-form"
        data-state="error"
        aria-label="Form-Schema ungültig"
      >
        <div className="srf-form__kicker">FORMULAR-FEHLER</div>
        <p className="srf-form__desc">Schema verworfen: {schemaErr}</p>
      </article>
    );
  }

  const setVal = (name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (errors.has(name)) {
      setErrors((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    setGlobalError(null);
    // Endpoint re-check just before submit (in case the schema mutated somehow).
    if (!isEndpointAllowed(schema.endpoint)) {
      setGlobalError('Endpoint nicht erlaubt — kein Submit.');
      return;
    }
    const errs = validateFormValues(schema.fields, values);
    if (errs.size > 0) {
      setErrors(errs);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(schema.endpoint.url, {
        method: schema.endpoint.method,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setGlobalError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDone(true);
      const { reply: replyBody } = sanitizeReplyValues(schema.fields, values);
      reply(
        schema.successMessage
          ? `${schema.successMessage}\n\n${replyBody}`
          : replyBody,
      );
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <article
        className="srf-form"
        data-state="done"
        aria-label="Formular gespeichert"
      >
        <div
          className="srf-form__kicker"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12.5l4 4 10-10" />
          </svg>
          Gespeichert
        </div>
        <div className="srf-form__title">{schema.title}</div>
        {schema.successMessage ? (
          <p className="srf-form__desc">{schema.successMessage}</p>
        ) : null}
      </article>
    );
  }

  return (
    <article className="srf-form" aria-label={schema.title}>
      <div className="srf-form__kicker">FORMULAR</div>
      <div className="srf-form__title">{schema.title}</div>
      {schema.subtitle ? (
        <p className="srf-form__desc">{schema.subtitle}</p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="srf-form__form"
      >
        {schema.fields.map((f) => (
          <FormFieldRow
            key={f.name}
            field={f}
            value={values[f.name] ?? ''}
            error={errors.get(f.name)}
            onChange={(v) => setVal(f.name, v)}
          />
        ))}

        {globalError ? (
          <div className="srf-form__error">{globalError}</div>
        ) : null}

        <div className="srf-form__actions">
          <span className="srf-form__hint">
            {schema.fields.some((f) => f.sensitive)
              ? 'Sensible Felder · landen verschlüsselt im Server-Storage'
              : 'wird sofort gespeichert'}
          </span>
          <button
            type="submit"
            disabled={submitting}
            className="srf-form__submit"
            aria-busy={submitting}
          >
            {submitting ? 'speichert …' : 'Speichern'}
          </button>
        </div>
      </form>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Field-Renderer
// ---------------------------------------------------------------------------

function FormFieldRow({
  field,
  value,
  error,
  onChange,
}: {
  field: FormField;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  const inputType =
    field.sensitive === true
      ? 'password'
      : field.type === 'textarea'
        ? 'textarea'
        : field.type === 'select'
          ? 'select'
          : field.type;

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void => {
    onChange(e.target.value);
  };

  return (
    <label className="srf-form__field">
      <span className="srf-form__label">
        {field.label}
        {field.required ? (
          <span className="srf-form__required">*</span>
        ) : null}
      </span>
      {field.helper ? (
        <span className="srf-form__helper">{field.helper}</span>
      ) : null}
      {inputType === 'textarea' ? (
        <textarea
          value={value}
          onChange={handleChange}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          className="srf-form__textarea"
        />
      ) : inputType === 'select' ? (
        <select
          value={value}
          onChange={handleChange}
          className="srf-form__select"
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={inputType}
          value={value}
          onChange={handleChange}
          placeholder={field.placeholder}
          className="srf-form__input"
          autoComplete={field.sensitive ? 'off' : undefined}
          spellCheck={field.sensitive ? false : undefined}
        />
      )}
      {error ? <span className="srf-form__field-error">{error}</span> : null}
    </label>
  );
}
