// lib/tool-scan.ts: which camera a scan opens, and what each hands back.
jest.mock('react-native-document-scanner-plugin', () => ({ scanDocument: jest.fn() }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Linking: {}, Platform: { OS: 'ios' } }));
const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() { return true; }
    delete() { mockDeleted.push(this.uri); }
  },
  Directory: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    create() {}
  },
  Paths: { cache: { uri: 'file:///c' } },
}));
let mockSettings: Record<string, unknown> = { quality: 'high' };
jest.mock('../lib/storage', () => ({ getScanSettings: async () => mockSettings }));
jest.mock('../lib/system-ui', () => ({ withSystemUI: (fn: () => unknown) => fn() }));
jest.mock('../lib/files', () => ({
  moveScannerOutputToCaches: (u: string[]) => u,
  deleteDisposableTemps: (u: string[]) => mockDeleted.push(...u),
}));
jest.mock('../lib/document-detect', () => ({ autoCropDocument: jest.fn() }));
jest.mock('../lib/page-source', () => ({
  isSourceInput: (p: unknown) => !!p && typeof p === 'object',
  geometryOfInput: (p: { quad: number[] }) => ({ quad: p.quad, rotation: 0 }),
  renderGeometry: jest.fn(async (_src: string, _g: unknown, out: string) => out),
}));
let mockAvailable = true;
jest.mock('../modules/vision-ocr/src/DocumentCameraView', () => ({ isDocumentCameraAvailable: () => mockAvailable }));
const mockOpen = jest.fn();
jest.mock('../lib/capture-session', () => ({
  openCaptureSession: (...a: unknown[]) => mockOpen(...a),
  toSourceInput: (sourceUri: string, g: { quad: number[]; rotation: number }) => ({ sourceUri, quad: g.quad, rotation: g.rotation }),
}));

import DocumentScanner from 'react-native-document-scanner-plugin';
import { cameraChoice, scanPagesWithCamera, scanWithCamera } from '../lib/tool-scan';

const Q = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
const captured = (n: number) => Array.from({ length: n }, (_, i) => ({
  key: `p${i}`, sourceUri: `file:///c/scanner-src/src-${i}.jpg`, width: 3000, height: 4000,
  geometry: { quad: Q, rotation: 0 }, detected: true, previewUri: null,
}));

beforeEach(() => {
  mockDeleted.length = 0;
  mockSettings = { quality: 'high' };
  mockAvailable = true;
  mockOpen.mockReset();
  (DocumentScanner.scanDocument as jest.Mock).mockReset();
});

test('Scan Kit camera by default; Apple’s scanner when chosen or when the build lacks the view', async () => {
  expect(await cameraChoice()).toBe('scankit');
  mockSettings = { quality: 'high', camera: 'apple' };
  expect(await cameraChoice()).toBe('apple');
  mockSettings = { quality: 'high', camera: 'scankit' };
  mockAvailable = false;
  expect(await cameraChoice()).toBe('apple');
});

test('Scan Kit camera pages come back as photos with their crop', async () => {
  mockOpen.mockResolvedValue(captured(2));
  const pages = await scanPagesWithCamera({ title: 'Book mode' });
  expect(mockOpen).toHaveBeenCalledWith({ title: 'Book mode' });
  expect(pages).toEqual([
    { sourceUri: 'file:///c/scanner-src/src-0.jpg', quad: Q, rotation: 0 },
    { sourceUri: 'file:///c/scanner-src/src-1.jpg', quad: Q, rotation: 0 },
  ]);
  expect(DocumentScanner.scanDocument).not.toHaveBeenCalled();
});

test('closing the camera is a cancel', async () => {
  mockOpen.mockResolvedValue(null);
  expect(await scanPagesWithCamera()).toBeNull();
});

test('Apple’s scanner: finished images, capped at maxPages (extras deleted)', async () => {
  mockSettings = { quality: 'high', camera: 'apple' };
  (DocumentScanner.scanDocument as jest.Mock).mockResolvedValue({ scannedImages: ['file:///c/a.jpg', 'file:///c/b.jpg'] });
  expect(await scanPagesWithCamera({ maxPages: 1 })).toEqual(['file:///c/a.jpg']);
  expect(mockDeleted).toContain('file:///c/b.jpg');
  expect(mockOpen).not.toHaveBeenCalled();
});

test('scanWithCamera renders the crops and deletes the photos', async () => {
  mockOpen.mockResolvedValue(captured(1));
  const out = await scanWithCamera();
  expect(out).toHaveLength(1);
  expect(out![0]).toMatch(/scanner-src\/page-/);
  expect(mockDeleted).toContain('file:///c/scanner-src/src-0.jpg');
});

describe('Android without Scan Kit’s camera (port phase 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RN = require('react-native') as { Platform: { OS: string }; Alert: { alert: jest.Mock } };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const picker = require('expo-image-picker') as { launchImageLibraryAsync: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const detect = require('../lib/document-detect') as { autoCropDocument: jest.Mock };
  type Btn = { text: string; onPress?: () => void };

  beforeEach(() => {
    RN.Platform.OS = 'android';
    mockAvailable = false;
    RN.Alert.alert.mockReset();
    picker.launchImageLibraryAsync.mockReset();
    detect.autoCropDocument.mockReset();
    detect.autoCropDocument.mockImplementation(async (uri: string) => ({ uri, detected: false }));
  });
  afterAll(() => {
    RN.Platform.OS = 'ios';
  });

  const pressInAlert = (label: string) => {
    RN.Alert.alert.mockImplementationOnce((_t: string, _m: string, buttons: Btn[]) => {
      buttons.find(b => b.text === label)?.onPress?.();
    });
  };

  test('says the camera is coming and imports photos instead; never opens Google’s scanner', async () => {
    pressInAlert('Import photos');
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///c/p1.jpg' }, { uri: 'file:///c/p2.jpg' }] });
    const pages = await scanPagesWithCamera();
    expect(RN.Alert.alert.mock.calls[0][0]).toBe('Camera coming soon on Android');
    expect(pages).toEqual(['file:///c/p1.jpg', 'file:///c/p2.jpg']);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsMultipleSelection: true }));
    expect(DocumentScanner.scanDocument).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('a one-page camera (Retake) picks one photo', async () => {
    pressInAlert('Import photos');
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///c/p1.jpg' }] });
    expect(await scanPagesWithCamera({ maxPages: 1 })).toEqual(['file:///c/p1.jpg']);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsMultipleSelection: false }));
  });

  test('Cancel (or dismissing the dialog) is a cancelled scan', async () => {
    pressInAlert('Cancel');
    expect(await scanPagesWithCamera()).toBeNull();
    RN.Alert.alert.mockImplementationOnce((_t: string, _m: string, _b: Btn[], opts: { onDismiss?: () => void }) => opts.onDismiss?.());
    expect(await scanPagesWithCamera()).toBeNull();
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(DocumentScanner.scanDocument).not.toHaveBeenCalled();
  });
});
