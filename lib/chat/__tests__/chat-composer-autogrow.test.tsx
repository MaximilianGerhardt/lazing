/**
 * Tests für ChatComposer auto-grow `<textarea>` + Submit/Interrupt-Tasten
 * (UX-1 · 2026-05-26, Bottom-Action-UX).
 *
 * Prüft:
 *   1. Das Eingabefeld ist ein <textarea> (kein <input> mehr).
 *   2. Auto-grow: Höhe wächst mit größerem scrollHeight, schrumpft zurück,
 *      cappt bei 7 Zeilen (overflow-y → auto).
 *   3. Enter (ohne Shift) → onSubmit; Shift+Enter → KEIN Submit (Newline).
 *   4. Cmd/Ctrl+Enter WÄHREND Streaming → onSendNow (Interrupt), nicht onSubmit.
 *   5. STT-Interim-Tail wird weiterhin gerendert (sttListening + sttInterim).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/chat-composer-autogrow.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChatComposer } from '../ChatComposer';

// happy-dom liefert scrollHeight standardmäßig 0 — wir mocken es als Funktion
// der Zeilenanzahl (≈ 23px pro Zeile), damit resizeTextarea echt rechnen kann.
const LINE_PX = 23;
function installScrollHeightMock(): () => void {
  const proto = HTMLTextAreaElement.prototype as unknown as {
    scrollHeight?: number;
  };
  const desc = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement): number {
      const lines = Math.max(1, (this.value.match(/\n/g)?.length ?? 0) + 1);
      return lines * LINE_PX;
    },
  });
  // getComputedStyle in happy-dom liefert lineHeight evtl. 'normal' → unser
  // Fallback (23px) greift. Wir lassen das absichtlich so, um den Fallback
  // mitzutesten.
  return () => {
    if (desc) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', desc);
    else
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
  };
}

interface MountResult {
  container: HTMLElement;
  root: Root;
  textarea: HTMLTextAreaElement;
  onSubmit: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  onSendNow: ReturnType<typeof vi.fn>;
  rerender: (props: Partial<Parameters<typeof ChatComposer>[0]>) => void;
  cleanup: () => void;
}

function mountComposer(
  overrides: Partial<Parameters<typeof ChatComposer>[0]> = {},
): MountResult {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const onSendNow = vi.fn();
  let value = overrides.value ?? '';

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const baseProps = {
    value,
    onChange: (v: string) => {
      value = v;
      onChange(v);
    },
    onSubmit,
    sttSupported: true,
    sttListening: false,
    onSttToggle: () => undefined,
    onStop: () => undefined,
    onSendNow,
    ...overrides,
  };

  const render = (props: Partial<Parameters<typeof ChatComposer>[0]>): void => {
    act(() => {
      root.render(<ChatComposer {...baseProps} {...props} value={props.value ?? value} />);
    });
  };
  render({});

  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

  return {
    container,
    root,
    textarea,
    onSubmit,
    onChange,
    onSendNow,
    rerender: render,
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

function dispatchKey(
  el: HTMLTextAreaElement,
  key: string,
  opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
): void {
  act(() => {
    const ev = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      shiftKey: opts.shiftKey ?? false,
      metaKey: opts.metaKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
    });
    el.dispatchEvent(ev);
  });
}

let activeCleanup: (() => void) | null = null;
let restoreScrollHeight: (() => void) | null = null;
afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
  restoreScrollHeight?.();
  restoreScrollHeight = null;
});

describe('ChatComposer — Eingabefeld ist eine textarea', () => {
  it('rendert <textarea>, kein <input type=text>', () => {
    const m = mountComposer({ value: 'Hallo' });
    activeCleanup = m.cleanup;
    expect(m.textarea).toBeTruthy();
    expect(m.textarea.tagName.toLowerCase()).toBe('textarea');
    // Es darf kein Text-Input mehr für die Eingabe geben (file-input erlaubt).
    const textInputs = Array.from(m.container.querySelectorAll('input')).filter(
      (i) => i.type === 'text',
    );
    expect(textInputs.length).toBe(0);
  });
});

describe('ChatComposer — Xcode-Pure Shell-Contract (Owner-Fix 2026-05-28)', () => {
  // Owner-Direktive: „doppelter Hintergrund, passt nicht zum restlichen Design
  // — wie bei Xcode gelöst." → kein zweiter Card-Background; Composer sitzt
  // auf dem Canvas, separiert durch eine Hairline.
  // Wir testen die strukturellen Invarianten, die das CSS in components.css
  // voraussetzt — die Klasse muss da sein, kein Inline-Background, der
  // Textarea-Container darf nicht selbst einen <div style="background:…"> sein.
  it('die Shell trägt KEINEN Inline-Background (Background lebt nur via CSS-Klasse)', () => {
    const m = mountComposer({ value: 'test' });
    activeCleanup = m.cleanup;
    const shell = m.container.querySelector('.lazyos-composer__shell') as HTMLElement;
    expect(shell).toBeTruthy();
    // Kein hard-coded inline background.
    expect(shell.style.background).toBe('');
    expect(shell.style.backgroundColor).toBe('');
  });

  it('die Shell-Klasse ist die einzige Hintergrund-Quelle (kein verschachteltes Background-Wrap)', () => {
    const m = mountComposer({ value: 'test' });
    activeCleanup = m.cleanup;
    // Composer-Form -> Shell -> Field/Actions: kein zusätzlicher
    // backgroundtragender Wrap dazwischen.
    const form = m.container.querySelector('.lazyos-composer') as HTMLElement;
    expect(form).toBeTruthy();
    // Form trägt selbst keinen Background.
    expect(form.style.background).toBe('');
    expect(form.style.backgroundColor).toBe('');
  });

  it('rendert die Mic + Send Buttons mit der canonischen Klasse (Token-bind via CSS)', () => {
    const m = mountComposer({ value: 'kurz' });
    activeCleanup = m.cleanup;
    const mic = m.container.querySelector('.lazyos-composer__mic');
    const send = m.container.querySelector('.lazyos-composer__send');
    expect(mic).toBeTruthy();
    expect(send).toBeTruthy();
  });
});

describe('ChatComposer — auto-grow Höhe', () => {
  it('wächst mit mehr Zeilen und schrumpft wieder zurück', () => {
    restoreScrollHeight = installScrollHeightMock();
    const m = mountComposer({ value: 'eine Zeile' });
    activeCleanup = m.cleanup;

    const oneLine = parseFloat(m.textarea.style.height) || 0;

    // 4 Zeilen → Höhe muss größer sein.
    m.rerender({ value: 'a\nb\nc\nd' });
    const fourLines = parseFloat(m.textarea.style.height) || 0;
    expect(fourLines).toBeGreaterThan(oneLine);

    // Zurück auf 1 Zeile → Höhe muss wieder schrumpfen.
    m.rerender({ value: 'kurz' });
    const shrunk = parseFloat(m.textarea.style.height) || 0;
    expect(shrunk).toBeLessThan(fourLines);
  });

  it('cappt bei 7 Zeilen und schaltet overflow-y auf auto', () => {
    restoreScrollHeight = installScrollHeightMock();
    // 12 Zeilen → über dem 7-Zeilen-Cap.
    const many = Array.from({ length: 12 }, (_, i) => `z${i}`).join('\n');
    const m = mountComposer({ value: many });
    activeCleanup = m.cleanup;

    const capped = parseFloat(m.textarea.style.height) || 0;
    // 7 Zeilen * 23px = 161px (+ padding 0 im Fallback). Höhe darf 7 Zeilen
    // nicht nennenswert überschreiten.
    expect(capped).toBeLessThanOrEqual(7 * LINE_PX + 4);
    expect(capped).toBeGreaterThan(5 * LINE_PX);
    expect(m.textarea.style.overflowY).toBe('auto');
  });

  it('bleibt bei kurzem Text auf overflow-y hidden', () => {
    restoreScrollHeight = installScrollHeightMock();
    const m = mountComposer({ value: 'kurz' });
    activeCleanup = m.cleanup;
    expect(m.textarea.style.overflowY).toBe('hidden');
  });
});

describe('ChatComposer — Tastatur', () => {
  it('Enter (ohne Shift) → onSubmit mit getrimmtem Wert', () => {
    const m = mountComposer({ value: '  hallo welt  ' });
    activeCleanup = m.cleanup;
    dispatchKey(m.textarea, 'Enter');
    expect(m.onSubmit).toHaveBeenCalledTimes(1);
    expect(m.onSubmit).toHaveBeenCalledWith('hallo welt');
  });

  it('Shift+Enter → KEIN Submit (Newline-Verhalten der Textarea)', () => {
    const m = mountComposer({ value: 'zeile 1' });
    activeCleanup = m.cleanup;
    dispatchKey(m.textarea, 'Enter', { shiftKey: true });
    expect(m.onSubmit).not.toHaveBeenCalled();
    expect(m.onSendNow).not.toHaveBeenCalled();
  });

  it('Cmd+Enter WÄHREND Streaming → onSendNow (Interrupt), nicht onSubmit', () => {
    const m = mountComposer({ value: 'sofort senden', isStreaming: true });
    activeCleanup = m.cleanup;
    dispatchKey(m.textarea, 'Enter', { metaKey: true });
    expect(m.onSendNow).toHaveBeenCalledTimes(1);
    expect(m.onSendNow).toHaveBeenCalledWith('sofort senden');
    expect(m.onSubmit).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter WÄHREND Streaming → onSendNow (Interrupt)', () => {
    const m = mountComposer({ value: 'jetzt', isStreaming: true });
    activeCleanup = m.cleanup;
    dispatchKey(m.textarea, 'Enter', { ctrlKey: true });
    expect(m.onSendNow).toHaveBeenCalledTimes(1);
    expect(m.onSubmit).not.toHaveBeenCalled();
  });

  it('Enter WÄHREND Streaming (ohne Modifier) → onSubmit (= Queue in ChatShell)', () => {
    // Der Composer ruft onSubmit auf; ChatShell entscheidet dann ob enqueued
    // wird. Wichtig: KEIN onSendNow ohne Modifier.
    const m = mountComposer({ value: 'einreihen', isStreaming: true });
    activeCleanup = m.cleanup;
    dispatchKey(m.textarea, 'Enter');
    expect(m.onSubmit).toHaveBeenCalledWith('einreihen');
    expect(m.onSendNow).not.toHaveBeenCalled();
  });
});

describe('ChatComposer — STT-Interim', () => {
  it('rendert den Interim-Tail wenn sttListening + sttInterim gesetzt', () => {
    const m = mountComposer({
      value: 'gesprochen',
      sttListening: true,
      sttInterim: 'live preview',
    });
    activeCleanup = m.cleanup;
    const interim = m.container.querySelector('.lazyos-composer__interim');
    expect(interim).toBeTruthy();
    expect(interim?.textContent).toContain('live preview');
  });
});
