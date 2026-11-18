// lib/tool-scan.ts: photos picked for a tool are auto-cropped; the ones where
// no page edges were found are remembered so the save can say so (lib/new-doc-note).
jest.mock('react-native-document-scanner-plugin', () => ({ scanDocument: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///c/ImagePicker/a.jpg' }, { uri: 'file:///c/ImagePicker/b.jpg' }] })),
}));
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Linking: {} }));
jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: {} }));
jest.mock('../lib/storage', () => ({ getScanSettings: async () => ({ quality: 'high' }) }));
jest.mock('../lib/system-ui', () => ({ withSystemUI: (fn: () => unknown) => fn() }));
const mockDeleted: string[] = [];
jest.mock('../lib/files', () => ({
  moveScannerOutputToCaches: (u: string[]) => u,
  deleteDisposableTemps: (u: string[]) => mockDeleted.push(...u),
}));
jest.mock('../lib/document-detect', () => ({
  autoCropDocument: async (uri: string) =>
    uri.endsWith('a.jpg') ? { uri: 'file:///tmp/doc-1.jpg', detected: true } : { uri, detected: false },
}));

jest.mock('../lib/page-source', () => ({ isSourceInput: () => false, geometryOfInput: jest.fn(), renderGeometry: jest.fn() }));
jest.mock('../lib/capture-session', () => ({ openCaptureSession: jest.fn(), toSourceInput: jest.fn() }));
jest.mock('../modules/vision-ocr/src/DocumentCameraView', () => ({ isDocumentCameraAvailable: () => false }));

import { pickPhotos, takeUncroppedPages } from '../lib/tool-scan';

test('pickPhotos reports the photos it couldn’t crop, once', async () => {
  const pages = (await pickPhotos(true))!;
  expect(pages).toEqual(['file:///tmp/doc-1.jpg', 'file:///c/ImagePicker/b.jpg']);
  expect(mockDeleted).toEqual(['file:///c/ImagePicker/a.jpg']); // the replaced picker copy
  expect(takeUncroppedPages(pages)).toEqual([1]);
  expect(takeUncroppedPages(pages)).toEqual([]);
});
