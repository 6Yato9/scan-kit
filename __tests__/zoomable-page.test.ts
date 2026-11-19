jest.mock('expo-image', () => ({ Image: 'Image' }));
import { DOUBLE_TAP_ZOOM, MAX_ZOOM, zoomRectAround } from '../components/zoomable-page';

describe('zoomRectAround', () => {
  it('centres the tapped point at the given scale', () => {
    expect(zoomRectAround(200, 300, 400, 600, 2)).toEqual({ x: 100, y: 150, width: 200, height: 300 });
  });

  it('keeps the rectangle inside the page near its edges', () => {
    expect(zoomRectAround(5, 5, 400, 600, 2)).toEqual({ x: 0, y: 0, width: 200, height: 300 });
    expect(zoomRectAround(399, 599, 400, 600, 2)).toEqual({ x: 200, y: 300, width: 200, height: 300 });
  });

  it('double-tap zoom stays within the pinch limit', () => {
    expect(DOUBLE_TAP_ZOOM).toBeGreaterThan(1);
    expect(DOUBLE_TAP_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);
  });
});
