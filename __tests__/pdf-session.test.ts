// __tests__/pdf-session.test.ts
// Password-protected PDFs unlocked for the session only (lib/pdf-session.ts):
// the stored file is never touched, the working copy is keyed to the stored
// bytes, and the session ends on background (App Lock on), after a long
// absence (App Lock off), and when the document is deleted. Native PDFKit and
// the file system are mocked: "enc(<password>:<plain>)" is an encrypted PDF.
const mockFs = new Map<string, string>();
const mockMtime = new Map<string, number>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  const strip = (u: string) => u.replace(/\/+$/, '');
  const DIR = '<dir>';
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return mockFs.has(this.uri) && mockFs.get(this.uri) !== DIR; }
    get size() { return mockFs.get(this.uri)?.length ?? 0; }
    get md5() { return `md5:${mockFs.get(this.uri)}`; }
    get modificationTime() { return mockMtime.get(this.uri) ?? 1000; }
    delete() { mockFs.delete(this.uri); }
    move(dest: MockFile) {
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return [...mockFs.keys()].some(f => f === this.uri || f.startsWith(`${this.uri}/`)); }
    create() { if (!mockFs.has(this.uri)) mockFs.set(this.uri, DIR); }
    delete() { for (const f of [...mockFs.keys()]) if (f === this.uri || f.startsWith(`${this.uri}/`)) mockFs.delete(f); }
    list() {
      const out = new Map<string, any>();
      for (const f of mockFs.keys()) {
        if (!f.startsWith(`${this.uri}/`)) continue;
        const child = `${this.uri}/${f.slice(this.uri.length + 1).split('/')[0]}`;
        if (!out.has(child)) out.set(child, new MockDirectory(child));
      }
      return [...out.values()];
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///caches' } } };
});

const ENC = /^enc\(([^:]+):(.*)\)$/;
const ALL = { printLow: true, printHigh: true, changeContent: true, assemblePages: true, copy: true, accessibility: true, comment: true, fillForms: true };
let mockPerms: Record<string, boolean> = { ...ALL };
const mockNative: any = {
  unlockPdf: jest.fn(async (inp: string, out: string, pw: string) => {
    const m = ENC.exec(mockFs.get(inp) ?? '');
    if (!m || m[1] !== pw) throw new Error('wrong-password');
    mockFs.set(out, m[2]);
    return out;
  }),
  pdfInfo: jest.fn(async (uri: string, pw?: string | null) => {
    const m = ENC.exec(mockFs.get(uri) ?? '');
    return { pageCount: 3, locked: !!m && pw !== m[1], encrypted: !!m };
  }),
  pdfPermissions: jest.fn(async () => ({ pageCount: 3, encrypted: true, locked: false, passwordAccepted: true, permissions: mockPerms })),
};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

import {
  adoptSessionCopy,
  forgetSession,
  handleAppStateForSessions,
  installPdfSessionWatch,
  isSessionPath,
  isSessionUnlocked,
  missingPermission,
  noteStoredPdfReplaced,
  readablePdfUri,
  resetPdfSessionsForTests,
  SESSION_IDLE_MS,
  sessionEndsOn,
  sessionPassword,
  sessionPermissionsForPath,
  sessionWriteSource,
  sessionAccessOf,
  sessionEditBlock,
  newSessionWorkFile,
  sweepEndedSessionFiles,
  withNoPasswordNote,
  NO_PASSWORD_NOTE,
  subscribePdfSessions,
  unlockForSession,
} from '../lib/pdf-session';

const PDF = 'file:///support/scan-kit/d1/document.pdf';
const DOC = { id: 'd1', pdfUri: `${PDF}?v=2` };
const copies = () => [...mockFs.keys()].filter(f => /\/pdf-session\/[^/]+\/.+\.pdf$/.test(f));

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  resetPdfSessionsForTests();
  mockFs.clear();
  mockMtime.clear();
  mockPerms = { ...ALL };
  mockFs.set(PDF, 'enc(pw1:v1)');
});

describe('unlocking for the session', () => {
  test('a wrong password is refused; nothing is remembered and no copy is left', async () => {
    await expect(unlockForSession(DOC, 'nope')).rejects.toMatchObject({ name: 'PdfSessionError', kind: 'wrong-password' });
    expect(isSessionUnlocked('d1')).toBe(false);
    expect(sessionPassword('d1')).toBeNull();
    expect(copies()).toEqual([]);
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    await expect(unlockForSession(DOC, '')).rejects.toMatchObject({ kind: 'wrong-password' });
  });

  test('the right password opens a decrypted working copy; the stored PDF is untouched', async () => {
    await unlockForSession(DOC, 'pw1');
    expect(isSessionUnlocked('d1')).toBe(true);
    expect(sessionPassword('d1')).toBe('pw1');
    const uri = await readablePdfUri(DOC);
    expect(isSessionPath(uri)).toBe(true);
    expect(mockFs.get(uri)).toBe('v1');
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    expect(sessionPermissionsForPath(uri)).toEqual(ALL);
    expect(sessionPermissionsForPath(PDF)).toBeNull();
  });

  test('not unlocked: the stored file is read as it is (native says "locked", as before)', async () => {
    await expect(readablePdfUri(DOC)).resolves.toBe(PDF);
    expect(mockNative.unlockPdf).not.toHaveBeenCalled();
  });

  test('without the native function it says so', async () => {
    const unlock = mockNative.unlockPdf;
    delete mockNative.unlockPdf;
    try {
      await expect(unlockForSession(DOC, 'pw1')).rejects.toMatchObject({ kind: 'unavailable' });
    } finally {
      mockNative.unlockPdf = unlock;
    }
  });
});

describe('the copy is keyed to the stored bytes', () => {
  test('reused while the stored file is unchanged', async () => {
    await unlockForSession(DOC, 'pw1');
    const a = await readablePdfUri(DOC);
    const b = await readablePdfUri(DOC);
    expect(b).toBe(a);
    expect(mockNative.unlockPdf).toHaveBeenCalledTimes(1);
  });

  test('made again from the stored file, with the remembered password, after it changed', async () => {
    await unlockForSession(DOC, 'pw1');
    const old = await readablePdfUri(DOC);
    mockFs.set(PDF, 'enc(pw1:v2-longer)');
    noteStoredPdfReplaced('d1');
    const next = await readablePdfUri(DOC);
    expect(next).not.toBe(old);
    expect(mockFs.get(next)).toBe('v2-longer');
    expect(mockNative.unlockPdf).toHaveBeenLastCalledWith(PDF, next, 'pw1');
  });

  test('Undo trap: same size and mtime, other bytes — the generation forces the MD5 check', async () => {
    await unlockForSession(DOC, 'pw1');
    await readablePdfUri(DOC);
    mockFs.set(PDF, 'enc(pw1:v9)'); // same length, same mtime
    noteStoredPdfReplaced('d1');
    expect(mockFs.get(await readablePdfUri(DOC))).toBe('v9');
  });

  test('byte-identical bytes put back (an Undo): the copy is kept, nothing decrypted again', async () => {
    await unlockForSession(DOC, 'pw1');
    const a = await readablePdfUri(DOC);
    mockMtime.set(PDF, 5000);
    noteStoredPdfReplaced('d1');
    expect(await readablePdfUri(DOC)).toBe(a);
    expect(mockNative.unlockPdf).toHaveBeenCalledTimes(1);
  });

  test('a write always checks the bytes, even when the stat key looks unchanged', async () => {
    await unlockForSession(DOC, 'pw1');
    mockFs.set(PDF, 'enc(pw1:v7)'); // no generation bump: only the MD5 can tell
    const src = await sessionWriteSource('d1', PDF);
    expect(src?.password).toBe('pw1');
    expect(mockFs.get(src!.uri)).toBe('v7');
  });

  test('the stored PDF no longer needs a password: the session ends and the stored file is read', async () => {
    await unlockForSession(DOC, 'pw1');
    const seen: string[] = [];
    subscribePdfSessions(id => seen.push(id));
    mockFs.set(PDF, 'plain now');
    noteStoredPdfReplaced('d1');
    await expect(readablePdfUri(DOC)).resolves.toBe(PDF);
    expect(isSessionUnlocked('d1')).toBe(false);
    // Told of the replacement, then of the end.
    expect(seen).toEqual(['d1', 'd1']);
  });

  test('after an in-place write the plaintext becomes the copy (adoptSessionCopy)', async () => {
    await unlockForSession(DOC, 'pw1');
    mockFs.set(PDF, 'enc(pw1:v3)');
    noteStoredPdfReplaced('d1');
    mockFs.set('file:///work/plain.pdf', 'v3');
    adoptSessionCopy('d1', 'file:///work/plain.pdf', PDF, { size: 11, md5: 'md5:enc(pw1:v3)' });
    expect(mockFs.has('file:///work/plain.pdf')).toBe(false);
    const uri = await readablePdfUri(DOC);
    expect(mockFs.get(uri)).toBe('v3');
    expect(mockNative.unlockPdf).toHaveBeenCalledTimes(1); // only the unlock itself
  });
});

describe('permissions', () => {
  test('missingPermission names the first one not allowed', () => {
    expect(missingPermission(ALL, ['assemblePages'])).toBeNull();
    expect(missingPermission({ ...ALL, comment: false }, ['assemblePages', 'comment'])).toBe('comment');
    expect(missingPermission(ALL)).toBeNull();
  });

  test('read with the password at unlock time; an operation they forbid is refused', async () => {
    mockPerms = { ...ALL, assemblePages: false };
    await unlockForSession(DOC, 'pw1');
    expect(mockNative.pdfPermissions).toHaveBeenCalledWith(PDF, 'pw1');
    await expect(readablePdfUri(DOC, { needs: ['assemblePages'] })).rejects.toMatchObject({ kind: 'restricted', message: 'restricted' });
    await expect(sessionWriteSource('d1', PDF, ['assemblePages'])).rejects.toMatchObject({ kind: 'restricted' });
    // Reading it is still fine.
    expect(mockFs.get(await readablePdfUri(DOC))).toBe('v1');
  });
});

describe('when the session ends', () => {
  test('sessionEndsOn: App Lock on ends it on background; off, after SESSION_IDLE_MS away', () => {
    expect(sessionEndsOn('background', true, null, 0)).toBe(true);
    expect(sessionEndsOn('background', false, null, 0)).toBe(false);
    expect(sessionEndsOn('inactive', true, null, 0)).toBe(false);
    expect(sessionEndsOn('active', false, 0, SESSION_IDLE_MS)).toBe(false);
    expect(sessionEndsOn('active', false, 0, SESSION_IDLE_MS + 1)).toBe(true);
    expect(sessionEndsOn('active', false, null, 10 * SESSION_IDLE_MS)).toBe(false);
  });

  test('App Lock on: going to the background ends it; listeners first, then the copy goes at once', async () => {
    await unlockForSession(DOC, 'pw1');
    const copy = await readablePdfUri(DOC);
    let existedWhenTold: boolean | null = null;
    subscribePdfSessions(() => { existedWhenTold = mockFs.has(copy); });
    handleAppStateForSessions('background', 1000, true);
    expect(isSessionUnlocked('d1')).toBe(false);
    expect(existedWhenTold).toBe(true);
    // No timer: a suspended app may never run one.
    expect(mockFs.has(copy)).toBe(false);
    // The next read is the stored, protected file: the viewer asks again.
    await expect(readablePdfUri(DOC)).resolves.toBe(PDF);
  });

  test('App Lock off: a short trip away keeps it; more than five minutes ends it', async () => {
    await unlockForSession(DOC, 'pw1');
    handleAppStateForSessions('background', 0, false);
    handleAppStateForSessions('active', SESSION_IDLE_MS - 1, false);
    expect(isSessionUnlocked('d1')).toBe(true);
    handleAppStateForSessions('background', 10_000, false);
    handleAppStateForSessions('inactive', 10_000 + SESSION_IDLE_MS + 5, false);
    expect(isSessionUnlocked('d1')).toBe(true);
    handleAppStateForSessions('active', 10_000 + SESSION_IDLE_MS + 10, false);
    expect(isSessionUnlocked('d1')).toBe(false);
  });

  test('a trashed or deleted document is forgotten (installPdfSessionWatch)', async () => {
    let removed: ((ids: string[]) => void) | null = null;
    const stop = installPdfSessionWatch({
      getAppLockEnabled: async () => false,
      subscribeAppLock: () => () => {},
      subscribeDocumentsRemoved: fn => { removed = fn; return () => {}; },
    });
    try {
      await unlockForSession(DOC, 'pw1');
      await unlockForSession({ id: 'd2', pdfUri: PDF }, 'pw1');
      removed!(['d1']);
      expect(isSessionUnlocked('d1')).toBe(false);
      expect(isSessionUnlocked('d2')).toBe(true);
    } finally {
      stop();
    }
  });

  test('a trashed record passed in is forgotten too; forgetSession() ends every one', async () => {
    await unlockForSession(DOC, 'pw1');
    await unlockForSession({ id: 'd2', pdfUri: PDF }, 'pw1');
    await expect(readablePdfUri({ ...DOC, trashedAt: 5 })).resolves.toBe(PDF);
    expect(isSessionUnlocked('d1')).toBe(false);
    forgetSession();
    expect(isSessionUnlocked('d2')).toBe(false);
  });
});

describe('round 14 critic fixes', () => {
  test('sessionAccessOf: which password opened it decides how a write keeps the protection', () => {
    const base = { locked: false, passwordAccepted: true, permissions: ALL, permissionBits: 129 };
    expect(sessionAccessOf({ ...base, ownerUnlocked: false, userPassword: true }).keep).toEqual({ mode: 'user', bits: 129 });
    expect(sessionAccessOf({ ...base, ownerUnlocked: true, userPassword: true }).keep).toEqual({ mode: 'same', bits: 129 });
    expect(sessionAccessOf({ ...base, ownerUnlocked: true, userPassword: false }).keep).toEqual({ mode: 'owner-only' });
    expect(sessionAccessOf({ ...base, ownerUnlocked: true, userPassword: null }).keep).toEqual({ mode: 'owner-only' });
    expect(sessionAccessOf({ locked: true }).permissions.assemblePages).toBe(false);
  });

  test('opened with the owner password: a write is refused before anything is read', async () => {
    mockNative.pdfPermissions.mockResolvedValueOnce({ pageCount: 3, encrypted: true, locked: false, passwordAccepted: true, ownerUnlocked: true, userPassword: false, permissionBits: 255, permissions: ALL });
    await unlockForSession(DOC, 'pw1');
    expect(sessionEditBlock('d1')).toBe('owner-password');
    await expect(sessionWriteSource('d1', PDF)).rejects.toMatchObject({ kind: 'restricted', message: 'owner-password' });
    // Reading it is fine.
    expect(mockFs.get(await readablePdfUri(DOC))).toBe('v1');
  });

  test('a write in progress holds readers back until it is done', async () => {
    await unlockForSession(DOC, 'pw1');
    const src = await sessionWriteSource('d1', PDF);
    let read = false;
    const reader = readablePdfUri(DOC).then(() => { read = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toBe(false);
    src!.done();
    await reader;
    expect(read).toBe(true);
  });

  test('work files live in the session folder; released ones are deleted; the active sweep removes strays', async () => {
    await unlockForSession(DOC, 'pw1');
    const keep = await readablePdfUri(DOC);
    const w = newSessionWorkFile('d1');
    expect(w.file.uri).toMatch(/^file:\/\/\/caches\/pdf-session\//);
    mockFs.set(w.file.uri, 'plain');
    sweepEndedSessionFiles();
    expect(mockFs.has(w.file.uri)).toBe(true); // in use
    w.release();
    expect(mockFs.has(w.file.uri)).toBe(false);
    const stray = keep.replace(/[^/]+$/, 'old-copy.pdf');
    mockFs.set(stray, 'v0');
    handleAppStateForSessions('active', 5, false);
    expect(mockFs.has(stray)).toBe(false);
    expect(mockFs.has(keep)).toBe(true);
  });

  test('new documents made from an unlocked PDF say they need no password', async () => {
    expect(withNoPasswordNote('Merged into a new PDF', ['d1', 'x'])).toBe('Merged into a new PDF');
    await unlockForSession(DOC, 'pw1');
    expect(withNoPasswordNote('Merged into a new PDF', ['x', 'd1'])).toBe(`Merged into a new PDF. ${NO_PASSWORD_NOTE}`);
    expect(withNoPasswordNote('PDF flattened. The original is kept.', ['d1'])).toBe(`PDF flattened. The original is kept. ${NO_PASSWORD_NOTE}`);
  });

  test('a stored-file replacement tells listeners (screens re-read it)', async () => {
    await unlockForSession(DOC, 'pw1');
    const seen: string[] = [];
    subscribePdfSessions(id => seen.push(id));
    noteStoredPdfReplaced('d1');
    expect(seen).toEqual(['d1']);
  });
});
