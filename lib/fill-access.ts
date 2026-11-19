// lib/fill-access.ts
//
// What Fill & sign can do with an imported PDF, known BEFORE opening it, so no
// entry point (the viewer's toolbar and "…" menu, Tools › Sign) leads to a
// dead end: a PDF whose author forbids changes isn't offered Fill & sign; one
// that allows filling its form only says so. Read from the same cheap native
// info the Fill & sign screen opens with (lib/pdf-fill.ts openFillSession),
// cached per file.
//
// `pdfUri` is the file to read: for a password-protected PDF unlocked this
// session, its decrypted copy (lib/pdf-session.ts readablePdfUri), whose
// author's permissions lib/pdf-fill openFillSession applies.
//
// Also remembers which PDFs were filled in here, so the viewer stops pushing
// "Convert to pages" (which would turn the filled form and its signatures
// into part of a picture) as the main thing to do with them.
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import type { NativeFillInfo } from '../modules/vision-ocr/src';
import { PdfEditError } from './pdf-edit';
import { canFillPdf, openFillSession } from './pdf-fill';
import { readablePdfUri, sessionSnapshot } from './pdf-session';

/**
 * - full: fields (if any) and additions
 * - form: its form only (the author forbids additions)
 * - annotate: additions only (the form, if any, can't be filled)
 * - none: the author forbids both
 * - locked: needs its password first (Fill & sign explains and offers to open it)
 * - unknown: couldn't be read, or this build can't fill PDFs
 */
export type FillAccessKind = 'full' | 'form' | 'annotate' | 'none' | 'locked' | 'unknown';
export type FillAccess = { kind: FillAccessKind; /** It has form fields to fill (not counting signature fields). */ hasFields: boolean };

/** Access from the native info (pure). */
export function fillAccessOf(info: Pick<NativeFillInfo, 'canAnnotate' | 'canFillForms' | 'fields'>): FillAccess {
  const hasFields = (info.fields ?? []).some(f => f.kind !== 'signature');
  const kind: FillAccessKind = info.canAnnotate
    ? info.canFillForms || !hasFields ? 'full' : 'annotate'
    : info.canFillForms && hasFields ? 'form' : 'none';
  return { kind, hasFields };
}

/** Why Fill & sign isn't offered, in a sentence (null when it is). */
export function fillBlockedReason(a: FillAccess | null | undefined): string | null {
  if (a?.kind === 'none') return 'Its author doesn’t allow filling in or signing it.';
  return null;
}

/** Why it can't be SIGNED (Tools › Sign), in a few words (null when it can). */
export function signBlockedReason(a: FillAccess | null | undefined): string | null {
  if (a?.kind === 'none') return 'Its author doesn’t allow changes';
  if (a?.kind === 'form') return 'Only its form can be filled in';
  return null;
}

const cache = new Map<string, Promise<FillAccess>>();

function keyFor(pdfUri: string): string {
  const uri = pdfUri.split('?')[0];
  let size = '';
  try {
    const f = new File(uri);
    size = f.exists ? String(f.size ?? '') : 'gone';
  } catch {}
  return `${uri}|${size}`;
}

/** What Fill & sign can do with the PDF at `pdfUri`. Never rejects. */
export function readFillAccess(pdfUri: string): Promise<FillAccess> {
  if (!canFillPdf()) return Promise.resolve({ kind: 'unknown', hasFields: false });
  const key = keyFor(pdfUri);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = openFillSession(pdfUri)
    .then(s => fillAccessOf(s.info))
    .catch((err): FillAccess => {
      cache.delete(key);
      return { kind: err instanceof PdfEditError && err.kind === 'locked' ? 'locked' : 'unknown', hasFields: false };
    });
  cache.set(key, p);
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return p;
}

/** readFillAccess as a hook: null until known. `version` re-reads (the file was rewritten). */
export function useFillAccess(pdfUri: string | null | undefined, version = 0): FillAccess | null {
  const [access, setAccess] = useState<{ uri: string; a: FillAccess } | null>(null);
  useEffect(() => {
    if (!pdfUri) return;
    let live = true;
    readFillAccess(pdfUri).then(a => { if (live) setAccess({ uri: pdfUri, a }); });
    return () => { live = false; };
  }, [pdfUri, version]);
  return pdfUri && access?.uri === pdfUri ? access.a : null;
}

/** Access for several PDFs at once (Tools › Sign's list), by document id. */
export function useFillAccessMap(docs: { id: string; pdfUri?: string | null }[]): Record<string, FillAccess> {
  const [map, setMap] = useState<Record<string, FillAccess>>({});
  const key = docs.map(d => `${d.id}:${d.pdfUri ?? ''}:${sessionSnapshot(d.id)}`).join(',');
  useEffect(() => {
    let live = true;
    const read = (d: { id: string; pdfUri?: string | null }) =>
      readablePdfUri(d)
        .catch(() => d.pdfUri as string)
        .then(readFillAccess)
        .then(a => [d.id, a] as const);
    Promise.all(docs.map(d => (d.pdfUri ? read(d) : null)))
      .then(rows => {
        if (!live) return;
        const next: Record<string, FillAccess> = {};
        for (const r of rows) if (r) next[r[0]] = r[1];
        setMap(next);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

// ── PDFs filled in here ──────────────────────────────────────────────────────

const FILLED_KEY = 'pdfFill.filled';
const MAX_FILLED = 500;
const filledListeners = new Set<() => void>();
let filledMemo: string[] | null = null;

async function readFilled(): Promise<string[]> {
  if (filledMemo) return filledMemo;
  try {
    const raw = await AsyncStorage.getItem(FILLED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    filledMemo = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    filledMemo = [];
  }
  return filledMemo;
}

/** The ids list after adding `id` (deduplicated, newest last, capped). */
export function withFilled(ids: string[], id: string, max = MAX_FILLED): string[] {
  return [...ids.filter(x => x !== id), id].slice(-max);
}

/** Remembers that document `id`'s PDF was filled in or signed here. Never throws. */
export async function noteFilledPdf(id: string): Promise<void> {
  try {
    const next = withFilled(await readFilled(), id);
    filledMemo = next;
    for (const l of [...filledListeners]) l();
    await AsyncStorage.setItem(FILLED_KEY, JSON.stringify(next));
  } catch {}
}

/** True once document `id` has been filled in here (null until read). */
export function useFilledPdf(id: string | null | undefined): boolean | null {
  const [filled, setFilled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () => { readFilled().then(ids => { if (live) setFilled(ids.includes(id)); }); };
    read();
    filledListeners.add(read);
    return () => {
      live = false;
      filledListeners.delete(read);
    };
  }, [id]);
  return filled;
}
