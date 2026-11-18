// app/tools/extract.tsx
// Copy chosen pages of a document into a new document. Each page travels with
// its .orig shadow (copyPageWithShadow) so its filter metadata stays truthful.
import { useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { DocRow, NoDocuments, SectionRow, ToolScreen, pageCountLabel, useToolDocuments } from '@/components/tool-ui';
import { saveDocument } from '@/lib/storage';
import { copyPageWithShadow, deleteDocumentFiles } from '@/lib/files';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing } from '@/lib/theme';
import type { Document } from '@/types/document';

export default function ExtractScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { docs, loaded } = useToolDocuments(d => !d.pdfUri && d.pages.length > 1);
  const [docId, setDocId] = useState<string | null>(null);
  const [pages, setPages] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const doc = docs.find(d => d.id === docId) ?? null;

  const pick = (d: Document) => {
    if (d.id === docId) return;
    setDocId(d.id);
    setPages(new Set());
  };

  const toggle = (i: number) =>
    setPages(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const allSelected = !!doc && pages.size === doc.pages.length;

  const handleExtract = async () => {
    if (!doc || pages.size === 0 || saving) return;
    setSaving(true);
    const newId = Crypto.randomUUID();
    try {
      const sorted = [...pages].sort((a, b) => a - b);
      const newPages = sorted.map((src, dest) => copyPageWithShadow(doc.pages[src], newId, dest));
      const filters = doc.filters ? sorted.map(i => doc.filters![i] ?? 'original') : undefined;
      const adjustments = doc.adjustments
        ? sorted.map(i => doc.adjustments![i] ?? { brightness: 0, contrast: 0, saturation: 0 })
        : undefined;
      const now = Date.now();
      await saveDocument({
        id: newId,
        name: `${doc.name} (${sorted.length === 1 ? 'page' : 'pages'} ${sorted.map(i => i + 1).join(', ')})`.slice(0, 120),
        pages: newPages,
        filters: !filters || filters.every(f => f === 'original') ? undefined : filters,
        adjustments:
          !adjustments || adjustments.every(a => !a.brightness && !a.contrast && !a.saturation)
            ? undefined
            : adjustments,
        folder: doc.folder,
        createdAt: now,
        updatedAt: now,
      });
      notifySuccess();
      show(`Extracted ${pageCountLabel(sorted.length)}`);
      router.replace({ pathname: '/viewer', params: { id: newId } });
    } catch {
      try { deleteDocumentFiles(newId); } catch {}
      notifyError();
      Alert.alert('Couldn’t extract pages', 'A page file couldn’t be copied. The original document is unchanged. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loaded && docs.length === 0) {
    return (
      <ToolScreen title="Extract pages">
        <NoDocuments
          title="No multi-page documents"
          subtitle="Extracting pages needs a document with at least two pages."
        />
      </ToolScreen>
    );
  }

  return (
    <ToolScreen
      title="Extract pages"
      footer={
        <PrimaryButton
          title={pages.size ? `Extract ${pageCountLabel(pages.size)}` : 'Select pages to extract'}
          onPress={handleExtract}
          disabled={pages.size === 0}
          loading={saving}
        />
      }
    >
      <SectionLabel>Document</SectionLabel>
      {docs.map(d => (
        <DocRow key={d.id} doc={d} selected={d.id === docId} onPress={() => pick(d)} />
      ))}

      {doc ? (
        <>
          <SectionRow
            label={`Pages, ${pages.size} selected`}
            action={allSelected ? 'Select none' : 'Select all'}
            onAction={() => setPages(allSelected ? new Set() : new Set(doc.pages.map((_, i) => i)))}
          />
          <View style={styles.grid}>
            {doc.pages.map((uri, i) => {
              const on = pages.has(i);
              return (
                <Pressable
                  key={`${uri}-${i}`}
                  onPress={() => toggle(i)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`Page ${i + 1}`}
                  style={[
                    styles.page,
                    { borderColor: on ? colors.accent : colors.border, backgroundColor: colors.placeholder },
                  ]}
                >
                  <Image source={{ uri: `${uri}?v=${doc.updatedAt}` }} style={styles.pageImg} resizeMode="cover" />
                  <View style={[styles.pageNum, { backgroundColor: on ? colors.accentFill : 'rgba(0,0,0,0.55)' }]}>
                    <Text style={[styles.pageNumText, { color: colors.onAccent }]}>{i + 1}</Text>
                  </View>
                  {on ? (
                    <View style={[styles.check, { backgroundColor: colors.accentFill }]}>
                      <Ionicons name="checkmark" size={16} color={colors.onAccent} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  page: {
    width: '30.5%',
    aspectRatio: 0.75,
    borderRadius: Radius.sm,
    overflow: 'hidden',
    borderWidth: 2,
  },
  pageImg: { width: '100%', height: '100%' },
  pageNum: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageNumText: { fontSize: 12, fontWeight: '700' },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
