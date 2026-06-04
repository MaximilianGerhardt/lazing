'use client';

/**
 * useSpeechRecognition — Web Speech API hook (hardened).
 *
 * Wraps `SpeechRecognition` / `webkitSpeechRecognition` behind an
 * ergonomic React API. No external deps, no polyfills.
 *
 * Support matrix (as of 2026-04):
 *   - macOS Safari 14.1+
 *   - iOS Safari 14.5+  (only in the browser tab)
 *   - iOS Safari PWA standalone mode  (the API exists, but throws
 *     a silent `service-not-allowed` or hangs). Detected here
 *     and reported as `isSupported=false` + `error='pwa-standalone-unsupported'`
 *     — the user gets a clear fallback hint.
 *   - Chrome/Edge desktop + mobile
 *   - Firefox  (no ctor)
 *
 * Behavior:
 *   - `interimResults: true` → `interimText` updated live.
 *   - `finalText` is emitted on recognition end (onFinal callback).
 *   - Auto-stop: `continuous: false` → Safari stops after ~2 s of silence.
 *   - Error: `error` set, `isListening=false`.
 *   - `isSecureContext` mandatory check — without HTTPS/localhost the
 *     browser allows no mic access.
 *
 * Error codes (stabilized):
 *   - 'not-supported'                 — the browser has no ctor
 *   - 'insecure-context'              — http (not localhost)
 *   - 'pwa-standalone-unsupported'    — iOS PWA home-screen mode
 *   - 'not-allowed' | 'service-not-allowed' — permission denied
 *   - 'no-speech' | 'audio-capture' | 'network' — runtime
 *   - 'start-failed' | 'init-failed'  — throw on create/start
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------
// Type shims — the Web Speech API is not fully typed in lib.dom
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
// Environment probes
// ---------------------------------------------------------------------

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as WindowWithSR;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * iOS Safari PWA standalone-mode detection.
 *
 * When the app runs as a home-screen PWA on iOS,
 * `webkitSpeechRecognition` exists, but the call hangs or throws silently.
 * We detect the environment and provide a clear fallback.
 *
 * Signatures:
 *   - `navigator.standalone === true` (Safari-specific)
 *   - display-mode: standalone + iOS user agent
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
  // `isSecureContext` is usually authoritative, but we explicitly
  // allow localhost (dev setup).
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

  // Lazy feature detect — once per mount.
  const env = useMemo(() => {
    const ctor = getCtor();
    const secure = isSecureForMic();
    const iosPwa = isIosPwaStandalone();
    // Priority of the error cases:
    //  1) No ctor → API missing entirely
    //  2) Not secure → the browser blocks the mic anyway
    //  3) iOS PWA → API present but broken — clear fallback
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

  // Hydration gate: `env.supported` is client-side (getCtor/navigator), always
  // false on the server. If we returned the real value immediately,
  // the SSR markup (mic „not available") would mismatch the first client
  // render (mic „available") → React hydration warning + attribute flip on the
  // composer mic button. We return `false` until after mount (== SSR),
  // then the effect flips to the real value. Canonical Next App Router
  // pattern for client-only feature detection.
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
    // Environment check first — a clear error code instead of silent nothing.
    if (!env.supported) {
      setError(env.supportedError ?? 'not-supported');
      if (process.env.NODE_ENV !== 'production') {
        // One-time dev hint for STT debugging.
          console.warn(
          '[useSpeechRecognition] start() aborted:',
          env.supportedError,
        );
      }
      return;
    }
    if (recRef.current) {
      // already running — no-op (the UI should read toggleStt via isListening)
      return;
    }
    setError(null);
    setInterimText('');
    setFinalText('');

    let rec: SpeechRecognitionLike;
    try {
      // Non-null assertion: env.supported guarantees ctor !== null.
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
