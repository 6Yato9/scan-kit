jest.mock('../lib/files', () => ({ containerRoot: () => 'file:///var/mobile/Containers/Data/Application/ABC/' }));
import { localImagesOutside, swapUrls, webviewReadRoot } from '../lib/webview-access';

const ROOT = 'file:///var/mobile/Containers/Data/Application/ABC/';
const LIB = `${ROOT}Library/`;

describe('webviewReadRoot', () => {
  it('is the container Library folder, never the container root', () => {
    expect(webviewReadRoot()).toBe(LIB);
    expect(webviewReadRoot(ROOT.slice(0, -1))).toBe(LIB);
  });
});

describe('localImagesOutside', () => {
  const page = `${LIB}Application%20Support/scan-kit/d1/page-0.orig.jpg`;
  const cam = `${LIB}Caches/scanner-src/preview-1.jpg`;
  const old = `${ROOT}Documents/DOCUMENT_SCAN_0_20250101_101010.jpg`;
  const tmp = `${ROOT}tmp/ABC-picked.jpg`;

  it('keeps images under Library (pages, camera captures), percent-encoded or not', () => {
    const html = `<img id="src" src="${page}"><script>var s='${cam}';</script><img src="${LIB}Application Support/x.jpg">`;
    expect(localImagesOutside(html, LIB)).toEqual([]);
  });

  it('finds images in Documents and tmp, once each, query strings included', () => {
    const html = `<img src="${old}"><img src="${old}"><div style="background:url(${tmp}?v=2)"></div>`;
    expect(localImagesOutside(html, LIB)).toEqual([old, `${tmp}?v=2`]);
  });

  it('treats /private/var and /var as the same place', () => {
    const html = `<img src="file:///private/var/mobile/Containers/Data/Application/ABC/Library/Caches/a.jpg">`;
    expect(localImagesOutside(html, LIB)).toEqual([]);
  });

  it('ignores data: and http URLs', () => {
    expect(localImagesOutside('<img src="data:image/png;base64,AAA"><img src="https://x/y.jpg">', LIB)).toEqual([]);
  });
});

describe('swapUrls', () => {
  it('replaces every occurrence of each swapped URL and nothing else', () => {
    const a = `${ROOT}Documents/a.jpg`;
    const b = `${LIB}Caches/b.jpg`;
    const html = `<img src="${a}"><img src="${b}"><script>load('${a}')</script>`;
    const out = swapUrls(html, new Map([[a, `${LIB}Caches/webview/img-1.jpg`]]));
    expect(out).toBe(`<img src="${LIB}Caches/webview/img-1.jpg"><img src="${b}"><script>load('${LIB}Caches/webview/img-1.jpg')</script>`);
  });
});
