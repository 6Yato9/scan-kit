// The Sign / Watermark / Timestamp drawing page, hardened for a phone
// (round 12: "Couldn't sign" on a real iPhone): one page in flight at a time,
// smaller canvases when WebKit can't give a full-size one, specific error
// codes, and a pen colour for the signature.
import { buildStampHtml, parseStampMessage, resolveStamp, STAMP_PIXEL_STEPS, SIGNATURE_INK } from '../lib/stamp';
import { BAKE_MAX_PIXELS } from '../lib/bake-html';

const sig = { dataUri: 'data:image/png;base64,AAAA', width: 400, height: 100 };

test('the canvas sizes start at the filter bake cap and only get smaller', () => {
  expect(STAMP_PIXEL_STEPS[0]).toBe(BAKE_MAX_PIXELS);
  expect(STAMP_PIXEL_STEPS[0]).toBeLessThanOrEqual(4096 * 4096);
  for (let i = 1; i < STAMP_PIXEL_STEPS.length; i++) expect(STAMP_PIXEL_STEPS[i]).toBeLessThan(STAMP_PIXEL_STEPS[i - 1]);
});

test('the page is drawn, posted and released before the shadow is loaded', () => {
  const html = buildStampHtml('file:///p.jpg', 'file:///p.orig.jpg', { kind: 'signature', signature: sig, placement: { x: 0.1, y: 0.2, w: 0.3 } });
  const pageAt = html.indexOf("side(SOURCES.page");
  const origAt = html.indexOf("side(SOURCES.orig");
  expect(pageAt).toBeGreaterThan(0);
  expect(origAt).toBeGreaterThan(pageAt);
  // The shadow's load is chained after the page's post, not started alongside it.
  expect(html).not.toMatch(/Promise\.all/);
  // Canvases give their memory back; images drop their pixels.
  expect(html).toContain('c.width = 0; c.height = 0;');
  expect(html).toContain("removeAttribute('src')");
  // Every failure has a code.
  for (const code of ['load-page', 'load-orig', 'load-signature', 'encode']) expect(html).toContain(code);
});

test('messages from the drawing page', () => {
  expect(parseStampMessage('STAMP_STEP:page-loaded')).toEqual({ type: 'step', what: 'page-loaded' });
  expect(parseStampMessage('STAMP_PAGE:data:image/jpeg;base64,AA')).toEqual({ type: 'page', data: 'data:image/jpeg;base64,AA' });
  expect(parseStampMessage('STAMP_ORIG:data:image/jpeg;base64,BB')).toEqual({ type: 'orig', data: 'data:image/jpeg;base64,BB' });
  expect(parseStampMessage('STAMP_DONE:{"scaled":true}')).toEqual({ type: 'done', scaled: true });
  expect(parseStampMessage('STAMP_DONE:garbage')).toEqual({ type: 'done', scaled: false });
  expect(parseStampMessage('STAMP_ERROR:load-orig')).toEqual({ type: 'error', code: 'load-orig' });
  expect(parseStampMessage('STAMP_ERROR:')).toEqual({ type: 'error', code: 'unknown' });
  expect(parseStampMessage('hello')).toBeNull();
});

test('pen colour: black draws the strokes as saved, blue recolours them', () => {
  expect(resolveStamp({ kind: 'signature', signature: sig, placement: { x: 0, y: 0, w: 0.3 } })).toMatchObject({ tint: null });
  expect(resolveStamp({ kind: 'signature', signature: sig, placement: { x: 0, y: 0, w: 0.3 }, ink: 'black' })).toMatchObject({ tint: null });
  expect(resolveStamp({ kind: 'signature', signature: sig, placement: { x: 0, y: 0, w: 0.3 }, ink: 'blue' })).toMatchObject({ tint: SIGNATURE_INK.blue });
});
