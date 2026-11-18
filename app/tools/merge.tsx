// app/tools/merge.tsx
// Combine several documents into a new one, in the order they were picked.
// Pages are copied with their .orig shadows (lib/files appendPages), so the
// merged document's filters stay editable and are never applied twice.
import { useState } from 'react';
import { Alert, StyleSheet, TextInput } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { DocRow, NoDocuments, ToolNote, ToolScreen, pageCountLabel, useToolDocuments } from '@/components/tool-ui';
import { saveDocument } from '@/lib/storage';
import { appendPages, deleteDocumentFiles } from '@/lib/files';
import { autoName } from '@/lib/auto-name';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

const NO_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

export default function MergeScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { docs, loaded } = useToolDocuments();
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(() => autoName(new Date(), 'Merged'));
  const [merging, setMerging] = useState(false);

  const selectedDocs = selected.map(id => docs.find(d => d.id === id)).filter(Boolean) as Document[];
  const totalPages = selectedDocs.reduce((sum, d) => sum + d.pages.length, 0);
  const ready = selectedDocs.length >= 2 && name.trim().length > 0;

  const toggle = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const handleMerge = async () => {
    if (!ready || merging) return;
    setMerging(true);
    const id = Crypto.randomUUID();
    try {
      const pages: string[] = [];
      const filters: PageFilter[] = [];
      const adjustments: PageAdjustment[] = [];
      for (const doc of selectedDocs) {
        pages.push(...appendPages(doc.pages, id, pages.length));
        doc.pages.forEach((_, i) => {
          filters.push(doc.filters?.[i] ?? 'original');
          adjustments.push(doc.adjustments?.[i] ?? { ...NO_ADJ });
        });
      }
      const folders = selectedDocs.map(d => d.folder);
      const sharedFolder = folders.every(f => f === folders[0]) ? folders[0] : undefined;
      const texts = selectedDocs.map(d => d.ocrText);
      const now = Date.now();
      await saveDocument({
        id,
        name: name.trim(),
        pages,
        filters: filters.every(f => f === 'original') ? undefined : filters,
        adjustments: adjustments.every(a => !a.brightness && !a.contrast && !a.saturation) ? undefined : adjustments,
        folder: sharedFolder,
        ocrText: texts.every(Boolean) ? texts.join('\n\n') : undefined,
        createdAt: now,
        updatedAt: now,
      });
      notifySuccess();
      show(`Merged into ${pageCountLabel(pages.length)}`);
      router.replace({ pathname: '/viewer', params: { id } });
    } catch {
      try { deleteDocumentFiles(id); } catch {}
      notifyError();
      Alert.alert('Couldn’t merge documents', 'Something went wrong copying the pages. Your documents are unchanged. Try again.');
    } finally {
      setMerging(false);
    }
  };

  if (loaded && docs.length < 2) {
    return (
      <ToolScreen title="Merge documents">
        <NoDocuments
          title={docs.length ? 'Only one document' : 'No documents yet'}
          subtitle="Merging needs at least two scanned documents. Scan or import another one first."
        />
      </ToolScreen>
    );
  }

  return (
    <ToolScreen
      title="Merge documents"
      footer={
        <PrimaryButton
          title={
            selectedDocs.length >= 2
              ? `Merge ${selectedDocs.length} documents (${pageCountLabel(totalPages)})`
              : 'Select at least 2 documents'
          }
          onPress={handleMerge}
          disabled={!ready}
          loading={merging}
        />
      }
    >
      <SectionLabel>New document name</SectionLabel>
      <TextInput
        style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={colors.muted}
        returnKeyType="done"
        maxLength={80}
        accessibilityLabel="New document name"
      />

      <SectionLabel>Documents, in order</SectionLabel>
      {docs.map(doc => {
        const order = selected.indexOf(doc.id) + 1;
        return (
          <DocRow
            key={doc.id}
            doc={doc}
            selected={order > 0}
            order={order || undefined}
            multi
            onPress={() => toggle(doc.id)}
          />
        );
      })}
      <ToolNote>Pages are added in the order you tap the documents. The originals are kept.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
});
