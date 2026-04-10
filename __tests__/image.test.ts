jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///tmp/rotated.jpg',
    width: 200,
    height: 400,
  }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({
    exists: true,
    delete: jest.fn(),
    copy: jest.fn(),
    uri: 'file:///documents/scan-kit/doc1/page-0.jpg',
  })),
  Directory: jest.fn(),
  Paths: { document: 'file:///documents' },
}));

import { rotatePage } from '../lib/image';
import { manipulateAsync } from 'expo-image-manipulator';

describe('rotatePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls manipulateAsync with rotate: 90 for cw', async () => {
    await rotatePage('file:///original.jpg', 'cw', 'doc1', 0);
    expect(manipulateAsync).toHaveBeenCalledWith(
      'file:///original.jpg',
      [{ rotate: 90 }],
      expect.objectContaining({ format: 'jpeg' })
    );
  });

  it('calls manipulateAsync with rotate: -90 for ccw', async () => {
    await rotatePage('file:///original.jpg', 'ccw', 'doc1', 0);
    expect(manipulateAsync).toHaveBeenCalledWith(
      'file:///original.jpg',
      [{ rotate: -90 }],
      expect.any(Object)
    );
  });
});
