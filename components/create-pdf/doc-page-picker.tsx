// components/create-pdf/doc-page-picker.tsx
// Create PDF › Documents: pick a document in Scan Kit, then some or all of
// its pages (every page is chosen to start with). Scanned documents and
// imported PDFs alike; a protected PDF asks for its password first
// (components/create-pdf/sources readyStoredPdf), one that doesn't allow its
// pages to be taken says so.
//
// A page sheet over the Create PDF screen. App Lock: the lock route would
// dismiss this RN Modal natively behind JS's back (see components/
// reorder-modal.tsx), so it closes itself properly while locked instead.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { HeaderIconButton, HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { DocGroup, DocRow, SelectionMark } from '@/components/tool-ui';
import { PageThumb } from '@/components/page-thumb';
import { EmptyState } from '@/components/empty-state';
import { SectionLabel } from '@/components/section-label';
import { useAppLocked } from '@/components/lock-gate';
import { getDocuments } from '@/lib/storage';
import { canCreateFromPdfs } from '@/lib/create-pdf-build';
import { chosenIndices, pagesLabel } from '@/lib/create-pdf';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import { readyStoredPdf, SourceError } from './sources';

export type PickedPages = {
  doc: Document;
  indices: number[];
  /** For a PDF: its page count and page thumbnails. */
  pdf?: { pageCount: number; thumbs: string[] };
};

type Chosen = { doc: Document; count: number; thumbs: string[]; pdf: boolean };

/** What the picker offers: scanned documents with pages, and PDFs when this build can combine them. */
export function pickableDocument(d: Document, pdfs = canCreateFromPdfs()): boolean {
  return !d.trashedAt && (d.pdfUri ? pdfs : d.pages.length > 0);
}

export function sourceRefusalMessage(err: SourceError): { title: string; body: string } | null {
  switch (err.kind) {
    case 'cancelled':
      return null;
    case 'restricted':
      return {
        title: `“${err.sourceName}” can’t be added`,
        body: 'Its author doesn’t allow its pages to be copied into another document.',
      };
    case 'unavailable':
      return { title: `“${err.sourceName}” is password protected`, body: 'This version of Scan Kit can’t open protected PDFs.' };
    case 'unreadable':
      return { title: `Couldn’t open “${err.sourceName}”`, body: 'The file may be damaged. Try another one.' };
  }
}

export function DocPagePicker({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (picked: PickedPages) => void;
}) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [opening, setOpening] = useState<string | null>(null);

  // App lock: close (an unfinished choice is dropped) and remount the Modal.
  const locked = useAppLocked();
  const [modalKey, setModalKey] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!locked || !visible) return;
    setModalKey(k => k + 1);
    onCloseRef.current();
  }, [locked, visible]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setChosen(null);
    setOpening(null);
    getDocuments()
      .then(all => {
        if (live) setDocs(all.filter(d => pickableDocument(d)).sort((a, b) => b.updatedAt - a.updatedAt));
      })
      .catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [visible]);

  const choose = async (doc: Document) => {
    if (opening) return;
    if (!doc.pdfUri) {
      setChosen({ doc, count: doc.pages.length, thumbs: doc.pages.map(p => `${p.split('?')[0]}?v=${doc.updatedAt}`), pdf: false });
      setSelected(new Set(doc.pages.map((_, i) => i)));
      return;
    }
    setOpening(doc.id);
    try {
      const ready = await readyStoredPdf(doc);
      setChosen({ doc: ready.doc, count: ready.pageCount, thumbs: ready.thumbs, pdf: true });
      setSelected(new Set(Array.from({ length: ready.pageCount }, (_, i) => i)));
    } catch (err) {
      const msg = err instanceof SourceError ? sourceRefusalMessage(err) : { title: `Couldn’t open “${doc.name}”`, body: 'Try again.' };
      if (msg) Alert.alert(msg.title, msg.body);
    } finally {
      setOpening(null);
    }
  };

  const toggle = (i: number) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const allOn = !!chosen && selected.size === chosen.count;
  const add = () => {
    if (!chosen || selected.size === 0) return;
    onAdd({
      doc: chosen.doc,
      indices: chosenIndices(selected, chosen.count),
      ...(chosen.pdf ? { pdf: { pageCount: chosen.count, thumbs: chosen.thumbs } } : {}),
    });
  };

  const cols = 3;
  const tileW = Math.floor((Math.min(width, 700) - Spacing.gutter * 2 - Spacing.md * (cols - 1)) / cols);

  return (
    <Modal key={modalKey} visible={visible && !locked} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        {chosen ? (
          <>
            <ScreenHeader
              withInset={false}
              title={chosen.doc.name}
              left={<HeaderIconButton icon="chevron-back" size={28} label="Documents" onPress={() => setChosen(null)} />}
              right={<HeaderTextButton title="Add" emphasis disabled={selected.size === 0} onPress={add} />}
            />
            <View style={styles.selectBar}>
              <Text style={[Type.footnote, { color: colors.muted }]} accessibilityLiveRegion="polite">
                {`${selected.size} of ${pagesLabel(chosen.count)} chosen`}
              </Text>
              <HeaderTextButton
                title={allOn ? 'Deselect all' : 'Select all'}
                onPress={() => setSelected(allOn ? new Set() : new Set(Array.from({ length: chosen.count }, (_, i) => i)))}
              />
            </View>
            <FlatList
              data={Array.from({ length: chosen.count }, (_, i) => i)}
              keyExtractor={i => String(i)}
              numColumns={cols}
              columnWrapperStyle={styles.gridRow}
              contentContainerStyle={styles.grid}
              renderItem={({ item: i }) => {
                const on = selected.has(i);
                const thumb = chosen.thumbs[i];
                return (
                  <Pressable
                    onPress={() => toggle(i)}
                    style={[styles.tile, { width: tileW }]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`Page ${i + 1}`}
                  >
                    <View
                      style={[
                        styles.tileFrame,
                        { height: Math.round(tileW * 1.3), backgroundColor: colors.placeholder, borderColor: on ? colors.accent : colors.thumbBorder },
                        on && styles.tileFrameOn,
                      ]}
                    >
                      {thumb ? (
                        <PageThumb uri={thumb} style={styles.fill} />
                      ) : (
                        <View style={[styles.fill, styles.center]}>
                          <Ionicons name="document-text-outline" size={28} color={colors.muted} />
                        </View>
                      )}
                      <View style={styles.mark}>
                        <SelectionMark selected={on} />
                      </View>
                    </View>
                    <Text style={[Type.footnote, styles.tileLabel, { color: on ? colors.text : colors.muted }]}>{`Page ${i + 1}`}</Text>
                  </Pressable>
                );
              }}
            />
          </>
        ) : (
          <>
            <ScreenHeader withInset={false} title="Add pages from" left={<HeaderTextButton title="Cancel" onPress={onClose} />} />
            {docs === null ? (
              <ActivityIndicator style={styles.loading} color={colors.muted} />
            ) : docs.length === 0 ? (
              <EmptyState
                icon="documents-outline"
                title="No documents yet"
                subtitle="Scan or import a document first, then add its pages here."
              />
            ) : (
              <FlatList
                data={[0]}
                keyExtractor={() => 'docs'}
                contentContainerStyle={styles.docs}
                renderItem={() => (
                  <View>
                    <SectionLabel>Choose a document</SectionLabel>
                    <DocGroup>
                      {docs.map(d => (
                        <View key={d.id}>
                          <DocRow doc={d} selected={false} onPress={() => choose(d)} />
                          {opening === d.id ? (
                            <ActivityIndicator style={styles.rowSpinner} color={colors.muted} />
                          ) : null}
                        </View>
                      ))}
                    </DocGroup>
                  </View>
                )}
              />
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  fill: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  loading: { marginTop: Spacing.xxxl },
  docs: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxxl },
  rowSpinner: { position: 'absolute', right: Spacing.lg, top: 0, bottom: 0 },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Spacing.gutter + Spacing.xs,
    paddingRight: Spacing.sm,
  },
  grid: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxxl, paddingTop: Spacing.sm },
  gridRow: { gap: Spacing.md, marginBottom: Spacing.md },
  tile: { alignItems: 'center' },
  tileFrame: { width: '100%', borderRadius: Radius.sm, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tileFrameOn: { borderWidth: 2 },
  mark: { position: 'absolute', top: Spacing.xs, right: Spacing.xs },
  tileLabel: { marginTop: Spacing.xs },
});
