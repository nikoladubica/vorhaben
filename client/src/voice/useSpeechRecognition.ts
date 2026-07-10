// Browser-native speech-to-text (Web Speech API) — no dependency, no audio ever leaves the page.
// Only the final text transcript is handed to the caller, which sends it to the parse endpoint.
// Firefox has no SpeechRecognition; there `supported` is false and the Capture page swaps the mic
// for a textarea feeding the same pipeline, so the feature degrades to quick-text-capture.

import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal Web Speech typings — the DOM lib does not ship SpeechRecognition, so declare just the
// surface this hook uses. Kept local (no ambient global augmentation) to avoid leaking types.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Map recognizer error codes to plain, actionable language.
function errorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return "Microphone access was blocked. Allow it in your browser's site settings.";
    case 'no-speech':
      return "Didn't catch anything — try again and speak after the button turns dark.";
    case 'audio-capture':
      return 'No microphone was found. Check that one is connected.';
    case 'network':
      return 'Speech recognition needs a network connection and it looks offline.';
    default:
      return 'Speech recognition stopped unexpectedly. Try again.';
  }
}

// Auto-stop this long after the last final result arrives (push-to-talk with a soft tail).
const SILENCE_MS = 3000;

export interface UseSpeechRecognition {
  supported: boolean;
  listening: boolean;
  interim: string;
  finalTranscript: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

export function useSpeechRecognition(
  options: { lang?: string } = {},
): UseSpeechRecognition {
  const lang = options.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

  const [supported] = useState(() => getCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearSilence();
    recRef.current?.stop();
  }, [clearSilence]);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    // Fresh capture each time.
    finalRef.current = '';
    setFinalTranscript('');
    setInterim('');
    setError(null);

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        const text = res[0].transcript;
        if (res.isFinal) {
          finalRef.current = `${finalRef.current} ${text}`.trim();
          // A final result restarts the silence countdown; 3s of quiet ends the capture.
          clearSilence();
          silenceTimer.current = setTimeout(stop, SILENCE_MS);
        } else {
          interimText += text;
        }
      }
      setFinalTranscript(finalRef.current);
      setInterim(interimText);
    };

    rec.onerror = (e) => {
      setError(errorMessage(e.error));
    };

    rec.onend = () => {
      clearSilence();
      setListening(false);
      setInterim('');
      recRef.current = null;
    };

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      // start() throws if called while already running — ignore; onend will reset state.
    }
  }, [lang, clearSilence, stop]);

  const reset = useCallback(() => {
    finalRef.current = '';
    setFinalTranscript('');
    setInterim('');
    setError(null);
  }, []);

  // Abort the recognizer on unmount so a background capture can't outlive the page.
  useEffect(() => {
    return () => {
      clearSilence();
      recRef.current?.abort();
      recRef.current = null;
    };
  }, [clearSilence]);

  return { supported, listening, interim, finalTranscript, error, start, stop, reset };
}
