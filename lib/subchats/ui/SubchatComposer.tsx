'use client';

/**
 * SubchatComposer — geteilter Composer (extern + intern).
 * WhatsApp-Standard: Anhang-Button (Fotos/Medien/Dokumente), Staging-Vorschau mit
 * Entfernen, autogrow-Textarea, runder Send-Button (SVG, keine Emojis). Der
 * Upload-Transport liegt beim Parent: onSend liefert Text + rohe Files; der Parent
 * lädt hoch und postet. Nur laz.ing-Tokens. Gathering-Intelligence (2026-06-02).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import * as s from './styles';
import { IconAttach, IconCamera, IconClose, IconFile, IconImage, IconMic, IconSend, IconStop } from './icons';
import { useMediaRecorderStt } from '@/lib/chat/useMediaRecorderStt';
import { useSpeechRecognition } from '@/lib/chat/useSpeechRecognition';
import type { UiAttachment } from './types';

const ACCEPT =
  'image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';

/**
 * Uploader (Progress-Modus): lädt EINE Datei hoch, meldet Fortschritt 0..100 und
 * resolved auf den fertigen Artefakt-Eintrag (oder wirft). Der Parent (z.B.
 * InternalSubchat) implementiert den Transport (XHR mit upload.onprogress).
 */
export type Uploader = (file: File, onProgress: (pct: number) => void) => Promise<UiAttachment>;

interface Staged {
  file: File;
  url: string | null; // objectURL nur für Bilder (Vorschau)
  pct?: number;
  status?: 'idle' | 'uploading' | 'done' | 'error';
  audioDurationMs?: number; // nur für aufgenommene Sprachnachrichten gesetzt
}

// Sprachnachricht-MIME-Kandidaten (lokale Kopie aus useMediaRecorderStt.pickMime;
// der private Helper wird bewusst NICHT importiert — Composer ist self-contained).
function pickAudioMime(): string {
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

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec < 10 ? `0${sec}` : sec}`;
}

type AttachSource = 'camera' | 'gallery' | 'file';

export function SubchatComposer({
  onSend,
  placeholder,
  busy = false,
  topSlot,
  seed,
  onTyping,
  uploader,
  onSendUploaded,
  enableVoice = false,
  enableVoiceMessage = false,
}: {
  /**
   * Legacy-Upload-Pfad (ExternalSubchat): Composer übergibt Text + rohe Files,
   * der Parent lädt hoch & postet. Optional, weil der Progress-Modus
   * (uploader + onSendUploaded) onSend nicht aufruft.
   */
  onSend?: (text: string, files: File[]) => Promise<void> | void;
  placeholder: string;
  busy?: boolean;
  topSlot?: React.ReactNode;
  /** Text von außen in den Composer setzen (z.B. KI-Vorschlag-Chip). nonce>0 triggert. */
  seed?: { text: string; nonce: number };
  /** Throttled (>=1/2s) bei jedem Tastendruck, solange der Entwurf nicht leer ist. */
  onTyping?: () => void;
  /** Wenn gesetzt: Composer treibt Per-Datei-Upload + Fortschritt und übergibt Artefakte an onSendUploaded. */
  uploader?: Uploader;
  /** Mit uploader genutzt: erhält Text + fertige Anhänge (statt onSend(text, files)). */
  onSendUploaded?: (text: string, attachments: UiAttachment[]) => Promise<void> | void;
  /** Mic-Button (Diktat in das Textfeld). Default false. Self-gated via STT-Support. */
  enableVoice?: boolean;
  /** Sprachnachricht-Aufnahme (raw audio → staged attachment). Default false.
   *  Erfordert Progress-Modus (uploader + onSendUploaded). Self-gated via getUserMedia/MediaRecorder. */
  enableVoiceMessage?: boolean;
}): React.ReactElement {
  const [draft, setDraft] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);
  const attachWrapRef = useRef<HTMLDivElement>(null);

  // Progress-Modus aktiv, wenn Parent beide Upload-Hooks liefert.
  const progressMode = !!uploader && !!onSendUploaded;

  // Sprach-Diktat — STT Dual-Path (2026-06-03, Owner-Befund „transkribiert nicht"):
  // on-device Web-Speech-API ZUERST (iOS-Safari/Chrome über HTTPS, KEIN Backend),
  // sonst MediaRecorder+Server-Whisper als Fallback — identisch zum Haupt-Composer
  // (lib/chat/ChatShell.tsx). Vorher nutzte der Subchat NUR Whisper → ohne
  // :4202-Daemon stumm. Das unified `stt`-Objekt lässt alle Aufrufer unverändert.
  const sttOnFinal = useCallback((t: string) => {
    const clean = t.trim();
    if (clean) setDraft((d) => (d ? `${d} ${clean}` : clean));
  }, []);
  const ws = useSpeechRecognition({ lang: 'de-DE', onFinal: sttOnFinal });
  const mr = useMediaRecorderStt({ lang: 'de', onFinal: sttOnFinal });
  const useWebSpeech = ws.isSupported;
  const stt = {
    isSupported: useWebSpeech ? ws.isSupported : mr.isSupported,
    isListening: useWebSpeech ? ws.isListening : mr.isListening,
    interimText: useWebSpeech ? ws.interimText : mr.interimText,
    error: useWebSpeech ? ws.error : mr.error,
    start: () => (useWebSpeech ? ws.start() : mr.start()),
    stop: () => (useWebSpeech ? ws.stop() : mr.stop()),
  };

  // ---- Sprachnachricht-Aufnahme (raw audio → staged attachment) ----
  // Eigene MediaRecorder-Instanz (NICHT useMediaRecorderStt, das die Blob
  // hochlädt + verwirft). Modelliert nach dessen pickMime/getUserMedia/
  // recorder.start(1000)/onstop-Muster, resolved aber zu einer Blob.
  const [recording, setRecording] = useState(false);
  const [recElapsedMs, setRecElapsedMs] = useState(0);
  const [audioHydrated, setAudioHydrated] = useState(false);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recStartRef = useRef<number>(0);
  const recMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setAudioHydrated(true);
  }, []);
  const audioSupportedReal =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';
  const isAudioSupported = audioHydrated && audioSupportedReal;

  const stopAudioTracks = useCallback(() => {
    if (audioStreamRef.current) {
      for (const track of audioStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      audioStreamRef.current = null;
    }
  }, []);

  const clearRecTimers = useCallback(() => {
    if (recMaxTimerRef.current) {
      clearTimeout(recMaxTimerRef.current);
      recMaxTimerRef.current = null;
    }
    if (recTickRef.current) {
      clearInterval(recTickRef.current);
      recTickRef.current = null;
    }
  }, []);

  const startAudio = useCallback(async () => {
    if (recording || !isAudioSupported) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // Mic verweigert/nicht gefunden → still nichts tun (kein Modal-Spam).
    }
    audioStreamRef.current = stream;
    audioChunksRef.current = [];

    const mime = pickAudioMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      stopAudioTracks();
      return;
    }
    audioRecorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) audioChunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      clearRecTimers();
      const usedMime = recorder.mimeType || mime || 'audio/webm';
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      stopAudioTracks();
      audioRecorderRef.current = null;
      const durationMs = recStartRef.current ? Date.now() - recStartRef.current : 0;
      const blob = new Blob(chunks, { type: usedMime });
      setRecording(false);
      setRecElapsedMs(0);
      // Stille/zu kurz → still verwerfen (nichts stagen).
      if (blob.size < 500) return;
      const ext = usedMime.includes('mp4') ? 'm4a' : usedMime.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = new File([blob], `Sprachnachricht-${stamp}.${ext}`, {
        type: usedMime.split(';')[0],
      });
      setUploadError(false);
      setStaged((prev) =>
        [...prev, { file, url: null, pct: 0, status: 'idle', audioDurationMs: durationMs } as Staged].slice(0, 10),
      );
    };
    recorder.onerror = () => {
      clearRecTimers();
      stopAudioTracks();
      audioRecorderRef.current = null;
      audioChunksRef.current = [];
      setRecording(false);
      setRecElapsedMs(0);
    };

    try {
      recorder.start(1000);
    } catch {
      stopAudioTracks();
      audioRecorderRef.current = null;
      return;
    }

    recStartRef.current = Date.now();
    setRecording(true);
    setRecElapsedMs(0);
    recTickRef.current = setInterval(() => {
      setRecElapsedMs(Date.now() - recStartRef.current);
    }, 250);
    // Hard-Cap 90s — schützt gegen vergessene Aufnahme.
    recMaxTimerRef.current = setTimeout(() => {
      const r = audioRecorderRef.current;
      if (r && r.state !== 'inactive') {
        try {
          r.stop();
        } catch {
          // ignore
        }
      }
    }, 90_000);
  }, [recording, isAudioSupported, stopAudioTracks, clearRecTimers]);

  const stopAudio = useCallback(() => {
    const r = audioRecorderRef.current;
    if (r && r.state !== 'inactive') {
      try {
        r.stop(); // triggert onstop → staging
      } catch {
        clearRecTimers();
        stopAudioTracks();
        audioRecorderRef.current = null;
        setRecording(false);
        setRecElapsedMs(0);
      }
    }
  }, [clearRecTimers, stopAudioTracks]);

  // ObjectURLs aufräumen + Audio-Aufnahme stoppen (Mic-Tracks + Timer).
  useEffect(() => {
    return () => {
      staged.forEach((s2) => s2.url && URL.revokeObjectURL(s2.url));
      if (recMaxTimerRef.current) clearTimeout(recMaxTimerRef.current);
      if (recTickRef.current) clearInterval(recTickRef.current);
      const r = audioRecorderRef.current;
      if (r && r.state !== 'inactive') {
        try {
          r.stop();
        } catch {
          // ignore
        }
      }
      if (audioStreamRef.current) {
        for (const track of audioStreamRef.current.getTracks()) {
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: Staged[] = [];
    for (const f of Array.from(files).slice(0, 10)) {
      next.push({
        file: f,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        pct: 0,
        status: 'idle',
      });
    }
    setUploadError(false);
    setStaged((prev) => [...prev, ...next].slice(0, 10));
  }, []);

  // Anhang-Quelle (Kamera / Fotos / Datei) anstoßen + Popover schließen.
  const pickSource = useCallback((src: AttachSource) => {
    setSourceOpen(false);
    const el = src === 'camera' ? cameraRef.current : src === 'gallery' ? galleryRef.current : fileRef.current;
    el?.click();
  }, []);

  // Popover bei Außen-Tap schließen.
  useEffect(() => {
    if (!sourceOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (attachWrapRef.current && !attachWrapRef.current.contains(e.target as Node)) {
        setSourceOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [sourceOpen]);

  const removeStaged = useCallback((idx: number) => {
    setStaged((prev) => {
      const item = prev[idx];
      if (item?.url) URL.revokeObjectURL(item.url);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const autogrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, []);

  // Externer Seed (KI-Vorschlag-Chip → Composer füllen + fokussieren).
  useEffect(() => {
    if (!seed || seed.nonce <= 0) return;
    setDraft(seed.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
        try {
          ta.setSelectionRange(ta.value.length, ta.value.length);
        } catch {
          /* ignore */
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // Tipp-Signal throttled (>=2s), nur solange Entwurf nicht leer ist.
  const fireTyping = useCallback(
    (value: string) => {
      if (!onTyping) return;
      if (!value.trim()) return;
      const now = Date.now();
      if (now - lastTypingRef.current < 2000) return;
      lastTypingRef.current = now;
      onTyping();
    },
    [onTyping],
  );

  const isUploading = staged.some((s2) => s2.status === 'uploading');
  const canSend = (draft.trim().length > 0 || staged.length > 0) && !busy && !isUploading;

  const clearAfterSend = useCallback(() => {
    setStaged((prev) => {
      prev.forEach((s2) => s2.url && URL.revokeObjectURL(s2.url));
      return [];
    });
    setDraft('');
    setUploadError(false);
    if (taRef.current) taRef.current.style.height = 'auto';
  }, []);

  const doSend = useCallback(() => {
    if (!canSend) return;
    const text = draft.trim();

    // Progress-Modus: Per-Datei-Upload mit Fortschritt, dann onSendUploaded.
    if (progressMode && uploader && onSendUploaded) {
      const snapshot = staged;
      setUploadError(false);
      void (async () => {
        const attachments: UiAttachment[] = [];
        for (let i = 0; i < snapshot.length; i++) {
          setStaged((prev) =>
            prev.map((it, idx) => (idx === i ? { ...it, status: 'uploading', pct: 0 } : it)),
          );
          try {
            const art = await uploader(snapshot[i].file, (pct) => {
              setStaged((prev) =>
                prev.map((it, idx) =>
                  idx === i ? { ...it, status: 'uploading', pct: Math.max(0, Math.min(100, pct)) } : it,
                ),
              );
            });
            // kind:'audio' muss die Message erreichen — der Uploader leitet kind
            // nur aus image/* vs. file ab. Bei Audio-Dateien lokal überschreiben.
            const fixed: UiAttachment = snapshot[i].file.type.startsWith('audio/')
              ? { ...art, kind: 'audio' }
              : art;
            attachments.push(fixed);
            setStaged((prev) =>
              prev.map((it, idx) => (idx === i ? { ...it, status: 'done', pct: 100 } : it)),
            );
          } catch {
            // N1: Datei bleibt gestaged, Entwurf bleibt erhalten; token-only Fehler.
            setStaged((prev) =>
              prev.map((it, idx) => (idx === i ? { ...it, status: 'error' } : it)),
            );
            setUploadError(true);
            return;
          }
        }
        await onSendUploaded(text, attachments);
        clearAfterSend();
      })();
      return;
    }

    // Legacy-Modus (ExternalSubchat, unverändert): rohe Files an onSend.
    if (!onSend) return;
    const files = staged.map((s2) => s2.file);
    staged.forEach((s2) => s2.url && URL.revokeObjectURL(s2.url));
    setDraft('');
    setStaged([]);
    if (taRef.current) taRef.current.style.height = 'auto';
    void onSend(text, files);
  }, [canSend, draft, staged, onSend, progressMode, uploader, onSendUploaded, clearAfterSend]);

  return (
    <div style={s.composerWrap}>
      {topSlot}

      {staged.length > 0 ? (
        <div style={s.stagedRow}>
          {staged.map((item, idx) => {
            const showBar = item.status === 'uploading' || (item.status === 'done' && (item.pct ?? 0) < 100);
            return (
              <div key={idx} style={s.stagedItem}>
                {item.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.url} alt={item.file.name} style={s.stagedThumb} />
                ) : null}
                {item.audioDurationMs != null ? (
                  <span style={s.stagedAudioMeta}>
                    <IconMic size={15} />
                    {formatDuration(item.audioDurationMs)}
                  </span>
                ) : (
                  <span style={s.stagedName}>{item.file.name}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeStaged(idx)}
                  style={s.stagedRemove}
                  aria-label="Anhang entfernen"
                >
                  <IconClose size={13} />
                </button>
                {showBar ? (
                  <div style={s.stagedProgressTrack} aria-hidden>
                    <div style={{ ...s.stagedProgressBar, width: `${item.pct ?? 0}%` }} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {uploadError ? <div style={s.stagedError}>Upload fehlgeschlagen</div> : null}

      {stt.isSupported && stt.isListening ? (
        <div style={s.voicePill}>{stt.interimText || 'Nehme auf…'}</div>
      ) : null}

      {stt.error && !stt.isListening ? (
        <div style={s.stagedError}>Spracheingabe nicht möglich — bitte tippen.</div>
      ) : null}

      {recording ? (
        <div style={s.recPill} role="status" aria-live="polite">
          {formatDuration(recElapsedMs)} · Aufnahme läuft
        </div>
      ) : null}

      <div style={s.composerInputRow}>
        {/* Drei explizite Quellen: Kamera, Galerie, Datei — alle versteckt. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = ''; // gleiche Datei erneut wählbar
          }}
        />

        <div ref={attachWrapRef} style={{ position: 'relative', flexShrink: 0 }}>
          {sourceOpen ? (
            <div style={s.sourcePopover} role="menu">
              <button type="button" style={s.sourceItem} onClick={() => pickSource('camera')} role="menuitem">
                <span style={s.sourceItemIcon}>
                  <IconCamera size={20} />
                </span>
                Kamera
              </button>
              <button type="button" style={s.sourceItem} onClick={() => pickSource('gallery')} role="menuitem">
                <span style={s.sourceItemIcon}>
                  <IconImage size={20} />
                </span>
                Fotos
              </button>
              <button type="button" style={s.sourceItem} onClick={() => pickSource('file')} role="menuitem">
                <span style={s.sourceItemIcon}>
                  <IconFile size={20} />
                </span>
                Datei
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setSourceOpen((v) => !v)}
            style={s.attachBtn}
            aria-label="Foto oder Datei anhängen"
            aria-haspopup="menu"
            aria-expanded={sourceOpen}
            disabled={busy}
          >
            <IconAttach size={22} />
          </button>
        </div>

        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            autogrow();
            fireTyping(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          style={s.composerInput}
        />

        {enableVoice && stt.isSupported ? (
          <button
            type="button"
            style={stt.isListening ? s.micBtnActive : s.micBtn}
            aria-label={stt.isListening ? 'Aufnahme stoppen' : 'Sprachnachricht diktieren'}
            aria-pressed={stt.isListening}
            // Push-to-record: gedrückt halten = aufnehmen, loslassen = transkribieren.
            onPointerDown={(e) => {
              e.preventDefault();
              stt.start();
            }}
            onPointerUp={() => stt.stop()}
            onPointerLeave={() => {
              if (stt.isListening) stt.stop();
            }}
            disabled={busy}
          >
            <IconMic size={22} />
          </button>
        ) : null}

        {enableVoiceMessage && isAudioSupported && progressMode ? (
          <button
            type="button"
            style={recording ? s.micBtnActive : s.micBtn}
            aria-label={recording ? 'Sprachnachricht-Aufnahme stoppen' : 'Sprachnachricht aufnehmen'}
            aria-pressed={recording}
            // Push-to-record: gedrückt halten = aufnehmen, loslassen = als Anhang stagen.
            onPointerDown={(e) => {
              e.preventDefault();
              void startAudio();
            }}
            onPointerUp={() => stopAudio()}
            onPointerLeave={() => {
              if (recording) stopAudio();
            }}
            disabled={busy}
          >
            {recording ? <IconStop size={20} /> : <IconMic size={22} />}
          </button>
        ) : null}

        <button
          type="button"
          onClick={doSend}
          disabled={!canSend}
          style={canSend ? s.sendBtn : (s.sendBtnDisabled as CSSProperties)}
          aria-label="Senden"
        >
          <IconSend size={20} />
        </button>
      </div>
    </div>
  );
}

export default SubchatComposer;
