// app/tools/reorder.tsx
// Pick a document, drag its pages into a new order, save. Page files and their
// .orig shadows move together (lib/files reorderPages).
import { useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { DocRow, NoDocuments, ToolNote, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { reorderPages } from '@/lib/files';
import { remapForReorder, runPageEdit } from '@/lib/bake';
import { patchDocument } from '@/lib/storage';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

type Item = { index: number; uri: string };

export default function ReorderScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { docs, loaded } = useToolDocuments(d => !d.pdfUri && d.pages.length > 1);
  const [doc, setDoc] = useState<Document | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [saving, setSaving] = useState(false);

  const changed = items.some((it, i) => it.index !== i);

  const choose = (d: Document) => {
    setDoc(d);
    setItems(d.pages.map((uri, index) => ({ index, uri })));
  };

  const save = async () => {
    if (!doc || !changed || saving) return;
    setSaving(true);
    try {
      const order = items.map(it => it.index);
      const noAdj: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
      const filters = doc.filters ? order.map(i => doc.filters![i] ?? ('original' as PageFilter)) : undefined;
      const adjustments = doc.adjustments ? order.map(i => doc.adjustments![i] ?? { ...noAdj }) : undefined;
      // Through runPageEdit so any filter bake still running follows its page
      // to the new position (it also drops the cached filter previews).
      await runPageEdit(doc.id, { remap: remapForReorder(order) }, async () => {
        const pages = reorderPages(doc.id, order);
        await patchDocument(doc.id, { pages, filters, adjustments, updatedAt: Date.now() });
      });
      notifySuccess();
      show('Pages reordered');
      router.replace({ pathname: '/viewer', params: { id: doc.id } });
    } catch {
      notifyError();
      Alert.alert('Couldn’t reorder pages', 'The pages were left in their original order. Try again.');
      setSaving(false);
    }
  };

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<Item>) => {
    const pos = (getIndex() ?? 0) + 1;
    return (
      <ScaleDecorator>
        <Pressable
          onLongPress={drag}
          delayLongPress={150}
          accessibilityRole="button"
          accessibilityLabel={`Page ${pos}, originally page ${item.index + 1}`}
          accessibilityHint="Touch and hold, then drag to move"
          style={[styles.row, { backgroundColor: isActive ? colors.accentLight : colors.card }]}
        >
          <Image
            source={{ uri: `${item.uri}?v=${doc?.updatedAt ?? 0}` }}
            style={[styles.thumb, { backgroundColor: colors.placeholder }]}
            resizeMode="cover"
          />
          <View style={styles.flex}>
            <Text style={[Type.subhead, { color: colors.text }]}>Page {pos}</Text>
            {item.index + 1 !== pos ? (
              <Text style={[Type.footnote, { color: colors.muted }]}>Was page {item.index + 1}</Text>
            ) : null}
          </View>
          <Pressable onPressIn={drag} hitSlop={8} style={styles.handle} accessibilityLabel={`Move page ${pos}`}>
            <Ionicons name="reorder-three-outline" size={28} color={colors.muted} />
          </Pressable>
        </Pressable>
      </ScaleDecorator>
    );
  };

  const header = <Stack.Screen options={{ headerShown: false }} />;

  if (loaded && docs.length === 0) {
    return (
      <>
        {header}
        <ToolScreen title="Reorder pages">
          <NoDocuments
            title="No multi-page documents"
            subtitle="Reordering needs a document with at least two pages."
          />
        </ToolScreen>
      </>
    );
  }

  if (!doc) {
    return (
      <>
        {header}
        <ToolScreen title="Reorder pages">
          <SectionLabel>Choose a document</SectionLabel>
          {docs.map(d => (
            <DocRow key={d.id} doc={d} selected={false} onPress={() => choose(d)} />
          ))}
        </ToolScreen>
      </>
    );
  }

  return (
    <>
      {header}
      <ToolScreen
        title="Reorder pages"
        scroll={false}
        footer={
          <PrimaryButton
            title={changed ? 'Save new order' : 'Drag pages to reorder'}
            onPress={save}
            disabled={!changed}
            loading={saving}
          />
        }
      >
        <DraggableFlatList
          data={items}
          onDragEnd={({ data }) => setItems(data)}
          keyExtractor={it => String(it.index)}
          renderItem={renderItem}
          containerStyle={styles.flex}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View>
              <SectionLabel>{doc.name}</SectionLabel>
              <ToolNote>Touch and hold a page, then drag it to a new position.</ToolNote>
              <View style={styles.headerGap} />
            </View>
          }
        />
      </ToolScreen>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxl },
  headerGap: { height: Spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.sm + 2,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
  },
  thumb: { width: 48, height: 64, borderRadius: 6 },
  handle: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
});
