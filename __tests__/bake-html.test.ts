import { buildBakeHtml } from '../lib/bake-html';

describe('buildBakeHtml', () => {
  it('sets ctx.filter to the given css before drawImage', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'grayscale(100%)');
    const filterIdx = html.indexOf("ctx.filter = 'grayscale(100%)'");
    const drawIdx = html.indexOf('drawImage');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(drawIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeLessThan(drawIdx);
  });

  it('draws at natural pixel size, not display size', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'none');
    expect(html).toContain('naturalWidth');
    expect(html).toContain('naturalHeight');
  });

  it('loads the given fileSrc into a hidden crossorigin img', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'none');
    expect(html).toContain('src="file:///tmp/page-0.jpg"');
    expect(html).toContain('crossorigin="anonymous"');
  });

  it('posts the canvas data URL via ReactNativeWebView.postMessage', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'none');
    expect(html).toContain("window.ReactNativeWebView.postMessage(canvas.toDataURL('image/jpeg', 0.92))");
  });

  it('escapes a single quote in the css so it cannot break out of the JS string literal', () => {
    const malicious = "'; window.ReactNativeWebView.postMessage('PWNED');//";
    const html = buildBakeHtml('file:///tmp/page-0.jpg', malicious);
    // The raw malicious payload must not appear verbatim inside a JS string
    // literal context that would let it terminate early.
    expect(html).not.toContain("ctx.filter = '';");
    expect(html).not.toContain("PWNED');//");
    // The quote must be escaped somehow (backslash-escaped).
    expect(html).toMatch(/ctx\.filter = '\\'; window\.ReactNativeWebView\.postMessage\(\\'PWNED\\'\);\/\/'/);
  });

  it('posts a BAKE_ERROR message on image load error', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'none');
    expect(html).toMatch(/img\.onerror\s*=/);
    expect(html).toContain('BAKE_ERROR');
  });

  it('has a try/catch around the draw so any thrown error posts BAKE_ERROR instead of hanging', () => {
    const html = buildBakeHtml('file:///tmp/page-0.jpg', 'none');
    expect(html).toContain('catch');
    // BAKE_ERROR should appear at least twice: once for img.onerror, once for the catch block.
    const occurrences = html.split('BAKE_ERROR').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
