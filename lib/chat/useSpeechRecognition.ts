'use client';

/**
 * useSpeechRecognition — Web-Speech-API-Hook (gehärtet).
 *
 * Kapselt `SpeechRecognition` / `webkitSpeechRecognition` hinter einer
 * ergonomischen React-API. Keine externen Deps, keine Polyfills.
 *
 * Support-Matrix (Stand 2026-04):
 *   - macOS Safari 14.1+ 
 *   - iOS Safari 14.5+  (nur im Browser-Tab)
 *   - iOS Safari PWA-Standalone-Mode  (API exisitiert, wirft aber
 *     silent `service-not-allowed` oder hängt). Wird hier detektiert
 *     und als `isSupported=false` + `error='pwa-standalone-unsupported'`
 *     gemeldet — der User bekommt einen klaren Fallback-Hinweis.
 *   - Chrome/Edge desktop + mobile 
 *   - Firefox  (kein Ctor)
 *
 * Verhalten:
 *   - `interimResults: true` → `interimText` updated live.
 *   - `finalText` wird bei Recognition-End emittiert (onFinal-Callback).
 *   - Auto-stop: `continuous: false` → Safari stoppt nach ~2 s Stille.
 *   - Fehler: `error` gesetzt, `isListening=false`.
 *   - `isSecureContext` Pflicht-Check — ohne HTTPS/localhost erlaubt
 *     der Browser keinen Mic-Zugriff.
 *
 * Fehler-Codes (stabilisiert):
 *   - 'not-supported'                 — Browser hat keinen Ctor
 *   - 'insecure-context'              — http (kein localhost)
 *   - 'pwa-standalone-unsupported'    — iOS-PWA-Home-Screen-Mode
 *   - 'not-allowed' | 'service-not-allowed' — Permission denied
 *   - 'no-speech' | 'audio-capture' | 'network' — Runtime
 *   - 'start-failed' | 'init-failed'  — Throw beim Erzeugen/Start
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------
// Type-Shims — Web Speech API ist in lib.dom nicht vollständig typisiert
// ---------------------------------------------------------------------
interface SR_Alternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SR_Result {
  readonly isFinal: boolean;
  readonly length: number;
  item(i: number): SR_Alternative;
  [index: number]: SR_Alternative;
}
interface SR_ResultList {
  readonly length: number;
  item(i: number): SR_Result;
  [index: number]: SR_Result;
}
interface SR_Event extends Event {
  readonly resultIndex: number;
  readonly results: SR_ResultList;
}
interface SR_ErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SR_Event) => void) | null;
  onerror: ((e: SR_ErrorEvent) => void) | null;
  onend: ((e: Event) => void) | null;
  onstart: ((e: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface WindowWithSR extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

// ---------------------------------------------------------------------
// Environment-Probes
// ---------------------------------------------------------------------

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as WindowWithSR;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * iOS Safari PWA-Standalone-Mode Detection.
 *
 * Wenn die App als Home-Screen-PWA auf iOS läuft, existiert
 * `webkitSpeechRecognition`, aber der Aufruf hängt oder wirft silent.
 * Wir erkennen das Environment und liefern einen klaren Fallback.
 *
 * Signatures:
 *   - `navigator.standalone === true` (Safari-spezifisch)
 *   - display-mode: standalone + iOS-User-Agent
 */
function isIosPwaStandalone(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const nav = navigator as NavigatorWithStandalone;
  const ua = nav.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (nav.platform === 'MacIntel' && 'ontouchend' in document);
  if (!isIOS) return false;
  if (nav.standalone === true) return true;
  // Fallback: display-mode media query.
  try {
    return window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function isSecureForMic(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  // `isSecureContext` ist i. d. R. authoritative, aber wir erlauben
  // localhost ausdrücklich (dev-Setup).
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------

export interface UseSpeechRecognitionOptions {
  lang?: string;
  /** Called with the final transcript when recognition ends successfully. */
  onFinal?: (text: string) => void;
}

export interface UseSpeechRecognitionReturn {
  /** API available AND environment OK (secure context, not iOS-PWA). */
  isSupported: boolean;
  /** Currently recording. */
  isListening: boolean;
  /** Live partial transcript (grey preview while speaking). */
  interimText: string;
  /** Last final transcript (also emitted via onFinal callback). */
  finalText: string;
  /** Error code/message if recognition failed. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const { lang = 'de-DE', onFinal } = options;

  // Lazy-feature-detect — einmal pro Mount.
  const env = useMemo(() => {
    const ctor = getCtor();
    const secure = isSecureForMic();
    const iosPwa = isIosPwaStandalone();
    // Priorität der Fehlerfälle:
    //  1) Kein Ctor → API fehlt komplett
    //  2) Nicht secure → Browser blockiert Mic sowieso
    //  3) iOS-PWA → API präsent aber broken — klarer Fallback
    let supportedError: string | null = null;
    if (!ctor) supportedError = 'not-supported';
    else if (!secure) supportedError = 'insecure-context';
    else if (iosPwa) supportedError = 'pwa-standalone-unsupported';
    return {
      ctor,
      supported: ctor !== null && secure && !iosPwa,
      supportedError,
    };
  }, []);

  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Hydration-Gate: `env.supported` ist clientseitig (getCtor/navigator), auf
  // dem Server immer false. Würden wir den echten Wert sofort zurückgeben,
  // mismatcht das SSR-Markup (Mic „nicht verfügbar") mit dem ersten Client-
  // Render (Mic „verfügbar") → React-Hydration-Warning + Attribut-Flip am
  // Composer-Mic-Button. Wir geben bis nach dem Mount `false` zurück (== SSR),
  // dann flippt der Effect auf den echten Wert. Kanonisches Next-App-Router-
  // Muster für Client-only-Feature-Detection.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Keep onFinal in a ref so start/stop callbacks stay stable.
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  // Cleanup on unmount — abort any in-flight recognition.
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // ignore
        }
        recRef.current = null;
      }
    };
  }, []);

  const start = useCallback(() => {
    // Environment-Check zuerst — klarer Fehlercode statt stilles Nichts.
    if (!env.supported) {
      setError(env.supportedError ?? 'not-supported');
      if (process.env.NODE_ENV !== 'production') {
        // Einmaliger Dev-Hinweis für STT-Debugging.
          console.warn(
          '[useSpeechRecognition] start() aborted:',
          env.supportedError,
        );
      }
      return;
    }
    if (recRef.current) {
      // already running — no-op (UI sollte toggleStt via isListening lesen)
      return;
    }
    setError(null);
    setInterimText('');
    setFinalText('');

    let rec: SpeechRecognitionLike;
    try {
      // Non-null assertion: env.supported garantiert ctor !== null.
      const Ctor = env.ctor;
      if (!Ctor) {
        setError('not-supported');
        return;
      }
      rec = new Ctor();
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
          console.warn('[useSpeechRecognition] ctor threw:', e);
      }
      setError(e instanceof Error ? e.message : 'init-failed');
      return;
    }

    rec.lang = lang;
    rec.continuous = false; // Auto-stop on silence (~2s on Safari)
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setIsListening(true);
    };

    rec.onresult = (event) => {
      let interim = '';
      let finalized = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalized += alt.transcript;
        } else {
          interim += alt.transcript;
        }
      }
      if (interim) setInterimText(interim);
      if (finalized) {
        setFinalText((prev) => (prev + finalized).trim());
        setInterimText('');
      }
    };

    rec.onerror = (event) => {
      if (process.env.NODE_ENV !== 'production') {
          console.warn('[useSpeechRecognition] error:', event.error, event.message);
      }
      // Common codes: 'not-allowed', 'no-speech', 'audio-capture', 'network'.
      setError(event.error || 'unknown');
      setIsListening(false);
    };

    rec.onend = () => {
      setIsListening(false);
      recRef.current = null;
      setInterimText('');
      // Flush final text to caller.
      setFinalText((prev) => {
        if (prev && onFinalRef.current) {
          try {
            onFinalRef.current(prev);
          } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
              console.warn('[useSpeechRecognition] onFinal threw:', err);
            }
          }
        }
        return prev;
      });
    };

    recRef.current = rec;

    try {
      rec.start();
    } catch (e) {
      // InvalidStateError if already started (shouldn't happen given the guard)
      if (process.env.NODE_ENV !== 'production') {
          console.warn('[useSpeechRecognition] start() threw:', e);
      }
      setError(e instanceof Error ? e.message : 'start-failed');
      setIsListening(false);
      recRef.current = null;
    }
  }, [env, lang]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // ignore — onend will fire regardless
    }
  }, []);

  return {
    isSupported: hydrated && env.supported,
    isListening,
    interimText,
    finalText,
    error,
    start,
    stop,
  };
}
