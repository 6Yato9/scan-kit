// Android (Fabric) crashed with "addViewAt: failed to insert view … The
// specified child already has a parent" when Whiteboard / Book mode opened
// the saved document (router.replace to the viewer).
//
// Root cause: a plain <View pointerEvents={busy ? 'none' : 'auto'}> is
// flattened away while 'auto' and becomes a real native view while 'none'
// (ViewShadowNode: pointerEvents none forms a stacking context). Toggling it
// moves its children between native parents. When that happens in the same
// commit as the screen being removed, react-native-screens has already started
// the screen's exit transition (startViewTransition on its views), so the old
// parent still holds the child and the insert into the new parent throws.
// `collapsable={false}` keeps the View a native view either way.
//
// This guard keeps every such toggle in the app pinned.
import fs from 'fs';
import path from 'path';

const ROOTS = ['app', 'components'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** Opening `<View …>` tags (attributes may span lines) whose pointerEvents switches to/from 'none'. */
export function unpinnedToggles(source: string): string[] {
  const out: string[] = [];
  const tag = /<(?:View|Animated\.View)\b([^<>]*?(?:=>[^<>]*?)*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(source))) {
    const attrs = m[1];
    const toggle = /pointerEvents=\{[^}]*\?\s*'(?:none|auto|box-none)'\s*:\s*'(?:none|auto|box-none)'[^}]*\}/.test(attrs);
    if (!toggle) continue;
    const toggled = /'none'/.test(attrs.match(/pointerEvents=\{[^}]*\}/)![0]);
    if (toggled && !/collapsable=\{false\}/.test(attrs)) out.push(m[0].split('\n')[0]);
  }
  return out;
}

describe('pointerEvents toggles are pinned against Fabric flattening', () => {
  it('finds an unpinned toggle, and accepts a pinned one', () => {
    expect(unpinnedToggles(`<View pointerEvents={busy ? 'none' : 'auto'}>`)).toHaveLength(1);
    expect(unpinnedToggles(`<View\n  style={s}\n  pointerEvents={busy ? 'none' : 'auto'}\n>`)).toHaveLength(1);
    expect(unpinnedToggles(`<View pointerEvents={busy ? 'none' : 'auto'} collapsable={false}>`)).toHaveLength(0);
    expect(unpinnedToggles(`<View pointerEvents="none">`)).toHaveLength(0);
  });

  it('every View in app/ and components/ whose pointerEvents switches to none keeps collapsable={false}', () => {
    const root = path.join(__dirname, '..');
    const found = ROOTS.flatMap(r => files(path.join(root, r)))
      .flatMap(f => unpinnedToggles(fs.readFileSync(f, 'utf8')).map(t => `${path.relative(root, f)}: ${t}`));
    expect(found).toEqual([]);
  });
});
