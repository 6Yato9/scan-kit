// lib/read-aloud.ts
// Read a page's text aloud with the system voices (AVSpeechSynthesizer, on
// device), in the language the text is written in (NLLanguageRecognizer).
// One reader at a time across the app: starting one stops any other.
//
// Reading stops when the screen or sheet that started it unmounts, and when
// the app leaves the foreground (here and natively), so a document is never
// read out behind the App Lock.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { VisionOcr, type SpeechProgressEvent, type SpeechStateEvent } from '../modules/vision-ocr/src';

export type ReadAloudState = 'idle' | 'starting' | 'speaking' | 'paused';

export function canReadAloud(): boolean {
  return typeof VisionOcr?.speak === 'function' && typeof VisionOcr?.addListener === 'function';
}

export { sentenceAt } from './sentences';

/** Text worth reading: something other than whitespace and punctuation. */
export function hasReadableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

let activeOwner: symbol | null = null;
/** States reported for an utterance before speak() resolved with its id. */
const early = new Map<number, string>();

/**
 * Read-aloud controls for `text`. `word` is the UTF-16 range being spoken
 * (null between words and when idle). Changing the text stops reading.
 */
export function useReadAloud(text: string) {
  const [state, setState] = useState<ReadAloudState>('idle');
  const [word, setWord] = useState<[number, number] | null>(null);
  const owner = useRef(Symbol('read-aloud')).current;
  const utterance = useRef<number | null>(null);
  // The text the current utterance reads (ranges refer to it).
  const [spoken, setSpoken] = useState('');

  const reset = useCallback(() => {
    utterance.current = null;
    setState('idle');
    setWord(null);
  }, []);

  const stop = useCallback(() => {
    if (activeOwner !== owner || utterance.current === null) {
      if (state !== 'idle') reset();
      return;
    }
    activeOwner = null;
    reset();
    VisionOcr?.stopSpeaking?.().catch(() => {});
  }, [owner, reset, state]);

  useEffect(() => {
    if (!canReadAloud()) return;
    const native = VisionOcr!;
    // A method of the native module: it must be called on the module (an
    // unbound call aborts in expo's EventEmitter).
    const add: NonNullable<typeof native.addListener> = (event, fn) => native.addListener!(event, fn);
    const s = add('onSpeechState', (e: SpeechStateEvent) => {
      if (activeOwner !== owner) return;
      // Events can beat speak()'s own reply: keep them for start() to replay.
      if (utterance.current === -1) {
        early.set(e.id, e.state);
        return;
      }
      if (e.id !== utterance.current) return;
      if (e.state === 'speaking') setState('speaking');
      else if (e.state === 'paused') setState('paused');
      else {
        activeOwner = null;
        utterance.current = null;
        setState('idle');
        setWord(null);
      }
    });
    const p = add('onSpeechProgress', (e: SpeechProgressEvent) => {
      if (activeOwner !== owner || e.id !== utterance.current) return;
      setWord([e.start, e.start + e.length]);
    });
    return () => {
      s.remove();
      p.remove();
    };
  }, [owner]);

  // Leaving the screen or the app ends reading.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background') stopRef.current();
    });
    return () => {
      sub.remove();
      if (activeOwner === owner) {
        activeOwner = null;
        VisionOcr?.stopSpeaking?.().catch(() => {});
      }
    };
  }, [owner]);

  // Edited text: the ranges no longer match, so stop.
  useEffect(() => {
    if (spoken && text !== spoken) stopRef.current();
  }, [text, spoken]);

  const start = useCallback(async () => {
    const speak = VisionOcr?.speak;
    if (typeof speak !== 'function' || !hasReadableText(text)) return false;
    activeOwner = owner;
    early.clear();
    utterance.current = -1; // until the native id arrives
    setSpoken(text);
    setWord(null);
    setState('starting');
    try {
      const { id } = await speak(text, null, null);
      if (activeOwner !== owner) return false;
      utterance.current = id;
      const before = early.get(id);
      early.clear();
      if (before === 'finished' || before === 'stopped') {
        activeOwner = null;
        reset();
      } else {
        setState(before === 'paused' ? 'paused' : 'speaking');
      }
      return true;
    } catch {
      if (activeOwner === owner) activeOwner = null;
      reset();
      return false;
    }
  }, [owner, reset, text]);

  const pause = useCallback(() => {
    if (activeOwner !== owner) return;
    setState('paused');
    VisionOcr?.pauseSpeaking?.().catch(() => {});
  }, [owner]);

  const resume = useCallback(() => {
    if (activeOwner !== owner) return;
    setState('speaking');
    VisionOcr?.resumeSpeaking?.().catch(() => {});
  }, [owner]);

  return { available: canReadAloud(), state, word, spoken, start, pause, resume, stop };
}
