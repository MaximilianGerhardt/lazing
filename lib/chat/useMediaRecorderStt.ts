'use client';

/**
 * useMediaRecorderStt — Fallback-STT via MediaRecorder + /api/stt/transcribe
 *
 * Used when the Web Speech API is not available (especially
 * iOS PWA standalone). Records audio via MediaRecorder (webm/opus or
 * mp4/aac depending on the browser), sends it to the server endpoint at the
 * end, which transcribes with faster-whisper.
 *
 * The API shape matches useSpeechRecognition so ChatComposer can use both
 * interchangeably:
 *   isSupported, isListening, interimText ('' during recording,
 *   'Transkribiere…' on upload), error, start(), stop().
 *
 * Difference from Web Speech:
 *   - No live interim tokens (faster-whisper transcribes at the end).
 *   - Longer latency on stop (server roundtrip, 1-3s typical).
 *   - Works EVERYWHERE getUserMedia works (incl. iOS PWA).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type MrSttErrorCode =
  | 'not-supported'
  | 'insecure-context'
  | 'mic-permission-denied'
  | 'mic-not-found'
  | 'recorder-failed'
  | 'upload-failed'
  | 'server-error'
  | 'timeout'
  | 'empty-result';

export interface UseMediaRecorderSttOptions {
  lang?: string; // default 'de'
  endpoint?: string; // default '/api/stt/transcribe'
  onFinal: (text: string) => void;
  /** Optional callback while uploading, so UI can show progress. */
  onStateChange?: (state: 'idle' | 'recording' | 'uploading') => void;
}

export interface UseMediaRecorderSttResult {
  isSupported: boolean;
  isListening: boolean;
  interimText: string; // shows "(nehme auf…)" / "(transkribiere…)"
  error: MrSttErrorCode | null;
  start: () => void;
  stop: () => void;
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // ignore
    }
  }
  return '';
}

export function useMediaRecorderStt(
  opts: UseMediaRecorderSttOptions,
): UseMediaRecorderSttResult {
  const {
    lang = 'de',
    endpoint = '/api/stt/transcribe',
    onFinal,
    onStateChange,
  } = opts;

  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<MrSttErrorCode | null>(null);
  const [interimText, setInterimText] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onFinalRef = useRef(onFinal);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onFinalRef.current = onFinal;
    onStateChangeRef.current = onStateChange;
  }, [onFinal, onStateChange]);

  // Hydration gate (see useSpeechRecognition): the real detection is
  // client-only (window/navigator/MediaRecorder), false on the server. Return
  // `false` until after mount so SSR and the first client render
  // match (otherwise mic-button attribute flip + hydration warning).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const supportedReal = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (!window.isSecureContext) return false;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
      return false;
    if (typeof MediaRecorder === 'undefined') return false;
    return true;
  }, []);
  const isSupported = hydrated && supportedReal;

  const cleanup = useCallback(() => {
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const handleStop = useCallback(async (): Promise<void> => {
    const mime = recorderRef.current?.mimeType || pickMime() || 'audio/webm';
    const chunks = chunksRef.current;
    chunksRef.current = [];

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
    recorderRef.current = null;
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }

    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 500) {
      // Too short / silent — skip upload
      setIsListening(false);
      setInterimText('');
      onStateChangeRef.current?.('idle');
      setError('empty-result');
      return;
    }

    setInterimText('Transkribiere…');
    onStateChangeRef.current?.('uploading');

    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 60_000);
    try {
      const resp = await fetch(`${endpoint}?lang=${encodeURIComponent(lang)}`, {
        method: 'POST',
        headers: { 'content-type': mime },
        body: blob,
        signal: ctl.signal,
        credentials: 'include',
      });
      clearTimeout(timeout);
      const json = (await resp.json()) as { text?: string; error?: string };
      if (!resp.ok || json.error) {
        setError('server-error');
      } else if (json.text && json.text.trim().length > 0) {
        onFinalRef.current(json.text.trim());
      } else {
        setError('empty-result');
      }
    } catch (err) {
      const isAbort = (err as { name?: string }).name === 'AbortError';
      setError(isAbort ? 'timeout' : 'upload-failed');
    } finally {
      clearTimeout(timeout);
      setIsListening(false);
      setInterimText('');
      onStateChangeRef.current?.('idle');
    }
  }, [endpoint, lang]);

  const start = useCallback(async () => {
    if (!isSupported) {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('insecure-context');
      } else {
        setError('not-supported');
      }
      return;
    }
    if (isListening) return;

    setError(null);
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('mic-permission-denied');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setError('mic-not-found');
      } else {
        setError('recorder-failed');
      }
      return;
    }
    streamRef.current = stream;

    const mime = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      setError('recorder-failed');
      cleanup();
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      void handleStop();
    };
    recorder.onerror = () => {
      setError('recorder-failed');
      cleanup();
      setIsListening(false);
      setInterimText('');
      onStateChangeRef.current?.('idle');
    };

    try {
      recorder.start(1000); // chunk-intervall 1s für smoother ondataavailable
    } catch {
      setError('recorder-failed');
      cleanup();
      return;
    }

    // Hard max 90s — guards against a forgotten recording
    maxDurationTimerRef.current = setTimeout(() => {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }, 90_000);

    setIsListening(true);
    setInterimText('Nehme auf…');
    onStateChangeRef.current?.('recording');
  }, [isSupported, isListening, cleanup, handleStop]);

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') {
      try {
        r.stop(); // triggers handleStop via onstop
      } catch {
        setError('recorder-failed');
        cleanup();
        setIsListening(false);
        setInterimText('');
        onStateChangeRef.current?.('idle');
      }
    }
  }, [cleanup]);

  return { isSupported, isListening, interimText, error, start, stop };
}

