// components/signature-pad.tsx
// The signature pad, shared by Sign (app/tools/sign.tsx) and Fill & sign
// (app/pdf-fill.tsx), and the sheet Fill & sign picks a signature or initials
// in: the saved ones (lib/saved-signatures.ts) as tiles, or drawn fresh on the
// pad. Its WebView loads an HTML string with no app files in it, so it needs
// no LocalWebView.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { tapLight } from '@/lib/haptics';
import { Ink, Radius, Spacing, Type } from '@/lib/theme';
import type { Signature } from '@/lib/stamp';
import {
  forgetSignature,
  listSavedSignatures,
  loadSavedSignature,
  type SavedSignature,
  type SignatureKind,
} from '@/lib/saved-signatures';

/**
 * The pad's page. Ink is drawn at device resolution in `ink` (the theme's text
 * colour, so the pad matches light and dark mode) on a transparent canvas.
 * Capture is implicit: a moment after each stroke the canvas is trimmed to the
 * strokes (plus a small margin), recoloured to `docInk` and posted back as a
 * PNG ({ dataUri, width, height }), or 'EMPTY'. `clearPad()` empties it.
 */
export function signaturePadHtml(ink: string, docInk: string, height: number): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{background:transparent;overflow:hidden;height:100%}
canvas{display:block;touch-action:none}</style></head><body><canvas id="c"></canvas>
<script>
var canvas = document.getElementById('c');
var ctx = canvas.getContext('2d');
var dpr = window.devicePixelRatio || 1;
var W = window.innerWidth, H = ${height};
canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
ctx.scale(dpr, dpr);
ctx.strokeStyle = '${ink}'; ctx.fillStyle = '${ink}'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
var drawing = false, drawn = false, last = null, timer = null;
function pt(e){ var t = e.touches[0], r = canvas.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
canvas.addEventListener('touchstart', function(e){ e.preventDefault(); clearTimeout(timer); drawing = true; last = pt(e);
  ctx.beginPath(); ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); drawn = true; }, { passive: false });
canvas.addEventListener('touchmove', function(e){ e.preventDefault(); if (!drawing) return; var p = pt(e);
  ctx.beginPath(); ctx.moveTo(last.x, last.y); var mx = (last.x + p.x) / 2, my = (last.y + p.y) / 2;
  ctx.quadraticCurveTo(last.x, last.y, mx, my); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; }, { passive: false });
canvas.addEventListener('touchend', function(){ drawing = false; clearTimeout(timer); timer = setTimeout(exportSignature, 250); });
function post(m){ window.ReactNativeWebView.postMessage(m); }
function exportSignature(){
  if (!drawn) { post('EMPTY'); return; }
  var w = canvas.width, h = canvas.height, d = ctx.getImageData(0, 0, w, h).data;
  var minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) { post('EMPTY'); return; }
  var m = Math.round(4 * dpr);
  minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(w - 1, maxX + m); maxY = Math.min(h - 1, maxY + m);
  var out = document.createElement('canvas'); out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  var o = out.getContext('2d');
  o.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  // Whatever colour the pad shows, the page gets dark ink.
  o.globalCompositeOperation = 'source-in'; o.fillStyle = '${docInk}'; o.fillRect(0, 0, out.width, out.height);
  post(JSON.stringify({ dataUri: out.toDataURL('image/png'), width: out.width, height: out.height }));
}
function clearPad(){ clearTimeout(timer); ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore(); drawn = false; }
</script></body></html>`;
}

/** A pad message as a Signature; null for 'EMPTY'; throws for anything malformed. */
export function parsePadMessage(data: string): Signature | null {
  if (data === 'EMPTY') return null;
  const parsed = JSON.parse(data) as Signature;
  if (!parsed?.dataUri?.startsWith('data:image/png') || !(parsed.width > 0) || !(parsed.height > 0)) throw new Error('bad signature');
  return parsed;
}

const PAD_HEIGHT = 170;

/**
 * Pick a saved signature (or initials), or draw one, in a sheet. `onPick` runs
 * when the user taps Add; the sheet then closes. Present whatever follows from
 * `onDismissed` (BottomSheet).
 */
export function SignatureSheet({
  visible,
  kind,
  onPick,
  onClose,
  onDismissed,
}: {
  visible: boolean;
  kind: SignatureKind;
  onPick: (sig: Signature) => void;
  onClose: () => void;
  onDismissed?: () => void;
}) {
  const { colors } = useTheme();
  const webRef = useRef<WebView>(null);
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<Signature | null>(null);
  const [loading, setLoading] = useState(false);
  const initials = kind === 'initials';

  useEffect(() => {
    if (!visible) return;
    setDrawn(null);
    setPick(null);
    listSavedSignatures(kind)
      .then(list => {
        setSaved(list);
        // The last one used is ready to go: one tap on Add.
        setPick(list[0]?.id ?? null);
      })
      .catch(() => setSaved([]));
  }, [visible, kind]);

  // The pad draws in the theme's text colour; a theme change reloads it empty.
  const html = useMemo(() => signaturePadHtml(colors.text, Ink.signature, PAD_HEIGHT), [colors.text]);

  const onPadMessage = (e: { nativeEvent: { data: string } }) => {
    try {
      const sig = parsePadMessage(e.nativeEvent.data);
      setDrawn(sig);
      if (sig) setPick(null);
    } catch {
      setDrawn(null);
    }
  };

  const clear = () => {
    webRef.current?.injectJavaScript('clearPad(); true;');
    setDrawn(null);
    tapLight();
  };

  const remove = (s: SavedSignature) => {
    Alert.alert(initials ? 'Remove these saved initials?' : 'Remove this saved signature?', 'You can save it again by using it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await forgetSignature(s.id, kind).catch(() => {});
          const list = await listSavedSignatures(kind).catch(() => []);
          setSaved(list);
          if (pick === s.id) setPick(null);
        },
      },
    ]);
  };

  const add = async () => {
    if (drawn) {
      onPick(drawn);
      return;
    }
    const s = saved.find(x => x.id === pick);
    if (!s) return;
    setLoading(true);
    try {
      onPick(await loadSavedSignature(s));
    } catch {
      Alert.alert(initials ? 'Couldn’t load your initials' : 'Couldn’t load the signature', 'Draw it in the box instead.');
    } finally {
      setLoading(false);
    }
  };

  const ready = !!drawn || (!!pick && saved.some(s => s.id === pick));
  const noun = initials ? 'initials' : 'signature';

  return (
    <BottomSheet visible={visible} onClose={onClose} onDismissed={onDismissed}>
      <SheetHeader
        title={initials ? 'Your initials' : 'Your signature'}
        subtitle={saved.length ? `Tap a saved ${noun}, or draw a new one.` : `Draw your ${noun} in the box.`}
      />
      <View style={styles.body}>
        {saved.length ? (
          <View style={styles.savedRow}>
            {saved.map((s, i) => {
              const on = pick === s.id && !drawn;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => {
                    setPick(s.id);
                    if (drawn) clear();
                    tapLight();
                  }}
                  onLongPress={() => remove(s)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, checked: on }}
                  accessibilityLabel={i === 0 ? `Last used ${noun}` : `Earlier ${noun}`}
                  accessibilityHint="Touch and hold to remove it"
                  style={({ pressed }) => [
                    styles.savedTile,
                    { backgroundColor: colors.bg, borderColor: on ? colors.accent : colors.thumbBorder },
                    on && styles.savedTileOn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Image key={colors.text} source={{ uri: s.uri }} style={[styles.savedImg, { tintColor: colors.text }]} resizeMode="contain" />
                  {on ? (
                    <View style={[styles.savedCheck, { backgroundColor: colors.accentFill }]}>
                      <Ionicons name="checkmark" size={13} color={colors.onAccent} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View style={[styles.pad, { borderColor: colors.border, backgroundColor: colors.bg }]}>
          {!drawn ? (
            <Text style={[Type.callout, styles.padHint, { color: colors.faint }]} pointerEvents="none">
              {initials ? 'Initials here' : 'Sign here'}
            </Text>
          ) : null}
          <View style={[styles.baseline, { backgroundColor: colors.ring }]} pointerEvents="none" />
          <WebView
            key={html}
            ref={webRef}
            source={{ html }}
            style={styles.padWeb}
            containerStyle={styles.padWeb}
            scrollEnabled={false}
            bounces={false}
            onMessage={onPadMessage}
            originWhitelist={['*']}
            accessibilityLabel={initials ? 'Initials pad' : 'Signature pad'}
          />
          {drawn ? (
            <Pressable
              onPress={clear}
              hitSlop={8}
              style={({ pressed }) => [styles.clear, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel={`Clear the ${noun}`}
            >
              <Text style={[Type.subhead, { color: colors.accent, fontWeight: '600' }]}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[Type.footnote, styles.note, { color: colors.muted }]}>
          {`Scan Kit keeps your last two ${initials ? 'sets of initials' : 'signatures'} on this iPhone only.`}
        </Text>
        <PrimaryButton
          title={initials ? 'Add initials' : 'Add signature'}
          onPress={() => { add(); }}
          disabled={!ready}
          loading={loading}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.md, gap: Spacing.md },
  savedRow: { flexDirection: 'row', gap: Spacing.sm },
  savedTile: {
    flex: 1,
    maxWidth: '50%',
    height: 72,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.sm,
    justifyContent: 'center',
  },
  savedTileOn: { borderWidth: 2, padding: Spacing.sm - 1.5 },
  savedImg: { width: '100%', height: '100%' },
  savedCheck: {
    position: 'absolute',
    top: Spacing.xs + 2,
    right: Spacing.xs + 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pad: { height: PAD_HEIGHT, borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  padWeb: { flex: 1, backgroundColor: 'transparent' },
  baseline: { position: 'absolute', left: 24, right: 24, bottom: 44, height: StyleSheet.hairlineWidth },
  padHint: { position: 'absolute', left: 24, bottom: 52 },
  clear: { position: 'absolute', top: Spacing.sm, right: Spacing.md, minHeight: 28, justifyContent: 'center' },
  note: { lineHeight: 18 },
});
