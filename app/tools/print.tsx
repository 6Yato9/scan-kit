// app/tools/print.tsx
// Choose a document and send it to the system print dialog. Scanned documents
// are laid out one page per sheet at the paper size from Document settings;
// imported PDFs print as they are.
import { useState } from 'react';
import { Alert } from 'react-native';
import { Stack } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { DocRow, NoDocuments, ToolNote, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { generatePdf } from '@/lib/pdf';
import { deleteQuietly, printFile, ShareError } from '@/lib/share';
import { getDocSettings } from '@/lib/storage';
import { notifyError } from '@/lib/haptics';

const printable = (d: { pdfUri?: string; pages: string[] }) => !!d.pdfUri || d.pages.length > 0;

export default function PrintScreen() {
  const { docs, loaded } = useToolDocuments(printable);
  const [docId, setDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doc = docs.find(d => d.id === docId) ?? null;

  const print = async () => {
    if (!doc || busy) return;
    setBusy(true);
    let temp: string | null = null;
    try {
      let uri = doc.pdfUri;
      if (!uri) {
        const { pdfPageSize } = await getDocSettings();
        temp = await generatePdf(doc.pages, { pageSize: pdfPageSize });
        uri = temp;
      }
      setBusy(false);
      await printFile(uri);
    } catch (err) {
      notifyError();
      Alert.alert(
        'Couldn’t print',
        err instanceof ShareError ? err.message : 'The document couldn’t be prepared for printing. Try again.',
      );
    } finally {
      setBusy(false);
      deleteQuietly(temp);
    }
  };

  const header = <Stack.Screen options={{ headerShown: false }} />;

  if (loaded && docs.length === 0) {
    return (
      <>
        {header}
        <ToolScreen title="Print">
          <NoDocuments subtitle="Scan or import a document, then print it from here." />
        </ToolScreen>
      </>
    );
  }

  return (
    <>
      {header}
      <ToolScreen
        title="Print"
        footer={
          <PrimaryButton
            title={busy ? 'Preparing…' : 'Print'}
            icon="print-outline"
            onPress={print}
            disabled={!doc}
            loading={busy}
          />
        }
      >
        <SectionLabel>Document</SectionLabel>
        {docs.map(d => (
          <DocRow key={d.id} doc={d} selected={d.id === docId} onPress={() => setDocId(d.id)} />
        ))}
        <ToolNote>Pages print one per sheet at the paper size set in Document settings.</ToolNote>
      </ToolScreen>
    </>
  );
}
