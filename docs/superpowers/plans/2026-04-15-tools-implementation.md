# Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four on-device tools (Whiteboard, Book Mode, Ask AI, Erase Marks), remove four backend-only stubs (To Word, To Excel, To PPT, Smart Erase).

**Architecture:** Each new tool is a standalone screen at `app/tools/<name>.tsx` following the existing ID Card pattern (router.push, standalone screen, back button). The ScanContext gets a minor extension so `openImport` accepts an optional `defaultFilter`. Ask AI calls the Anthropic Messages API directly from the device; the user's API key is stored in AsyncStorage. Erase Marks uses the existing filter/adjustment pipeline (CSS filters applied at render and PDF-export time via `lib/filters.ts`).

**Tech Stack:** React Native, Expo Router, `expo-image-manipulator` (`manipulateAsync` / `SaveFormat`), `react-native-document-scanner-plugin`, `expo-file-system`, `@react-native-async-storage/async-storage`, Anthropic Messages API (`claude-haiku-4-5-20251001`)

---

## File Map

| Status | Path | Purpose |
|--------|------|---------|
| Modify | `app/(tabs)/tools.tsx` | Remove 4 stubs, wire 4 new routes |
| Modify | `contexts/scan-context.tsx` | Add optional `defaultFilter` param to `openImport` |
| Modify | `lib/storage.ts` | Add `getAiKey` / `setAiKey` / `clearAiKey` |
| Create | `app/tools/whiteboard.tsx` | Scan + auto-apply 'enhanced' filter |
| Create | `app/tools/book.tsx` | Scan + split image at midpoint → 2 pages |
| Create | `app/tools/ask-ai.tsx` | Document picker + Claude API question answering |
| Create | `app/tools/erase-marks.tsx` | Apply high-contrast bw preset to document pages |

---

## Key APIs (read before coding)

**`lib/storage.ts`**
```typescript
export async function getDocuments(): Promise<Document[]>
export async function updateDocument(doc: Document): Promise<void>
```

**`expo-image-manipulator`** (import style used in this project):
```typescript
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
const result = await manipulateAsync(uri, [{ crop: { originX, originY, width, height } }], {
  compress: 0.9,
  format: SaveFormat.JPEG,
});
// result.uri is the new file URI
```

**`types/document.ts`**
```typescript
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';
export type PageAdjustment = { brightness: number; contrast: number; saturation: number }; // -100 to 100
export type Document = {
  id: string; name: string; pages: string[]; filters?: PageFilter[];
  adjustments?: PageAdjustment[]; createdAt: number; updatedAt: number;
  folder?: string; pdfUri?: string;
};
```

**`contexts/scan-context.tsx`** — `useScan()` hook exposes:
```typescript
openImport: (pages: string[]) => Promise<void>  // will become optional defaultFilter
```

---

### Task 1: Remove backend-only stubs

**Files:**
- Modify: `app/(tabs)/tools.tsx`

- [ ] **Step 1: Delete the four soon-only tool objects**

Open `app/(tabs)/tools.tsx`. In the `sections` array:

In the **Convert** section, delete these three objects:
```typescript
{
  id: 'to-word',
  icon: 'microsoft-word',
  label: 'To Word',
  color: '#42A5F5',
  soon: true,
},
{
  id: 'to-excel',
  icon: 'microsoft-excel',
  label: 'To Excel',
  color: '#66BB6A',
  soon: true,
},
{
  id: 'to-ppt',
  icon: 'microsoft-powerpoint',
  label: 'To PPT',
  color: '#EF5350',
  soon: true,
},
```

In the **Edit** section, delete this object:
```typescript
{
  id: 'smart-erase',
  icon: 'eraser',
  label: 'Smart Erase',
  color: '#EF5350',
  soon: true,
},
```

- [ ] **Step 2: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors (or pre-existing errors only — zero new ones).

- [ ] **Step 3: Commit**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit
git add app/\(tabs\)/tools.tsx
git commit -m "chore: remove backend-only soon stubs (Word, Excel, PPT, Smart Erase)"
```

---

### Task 2: Extend ScanContext — optional defaultFilter on openImport

**Files:**
- Modify: `contexts/scan-context.tsx`

Whiteboard needs to call `openImport(pages, 'enhanced')` to pre-select the enhanced filter in the review screen.

- [ ] **Step 1: Update the ScanContextType interface**

In `contexts/scan-context.tsx`, find line 10 (the `openImport` line in `ScanContextType`) and change:
```typescript
// Before:
openImport: (pages: string[]) => Promise<void>;

// After:
openImport: (pages: string[], defaultFilter?: PageFilter | 'original') => Promise<void>;
```

- [ ] **Step 2: Update the openImport implementation**

Find the `openImport` callback (~line 50) and change:
```typescript
// Before:
const openImport = useCallback(async (pages: string[]) => {
  try {
    const settings = await getScanSettings();
    setPendingPages(pages);
    setPendingPdfUri(null);
    setPendingQuality(QUALITY_MAP[settings.quality]);
    setPendingDefaultFilter('original');
    setReviewVisible(true);
  } catch (err) {
    console.error('Import failed', err);
  }
}, []);

// After:
const openImport = useCallback(async (pages: string[], defaultFilter?: PageFilter | 'original') => {
  try {
    const settings = await getScanSettings();
    setPendingPages(pages);
    setPendingPdfUri(null);
    setPendingQuality(QUALITY_MAP[settings.quality]);
    setPendingDefaultFilter(defaultFilter ?? 'original');
    setReviewVisible(true);
  } catch (err) {
    console.error('Import failed', err);
  }
}, []);
```

- [ ] **Step 3: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 4: Commit**
```bash
git add contexts/scan-context.tsx
git commit -m "feat: allow openImport to accept an optional defaultFilter"
```

---

### Task 3: Whiteboard tool

**Files:**
- Create: `app/tools/whiteboard.tsx`
- Modify: `app/(tabs)/tools.tsx`

Scans and opens the review screen with the 'enhanced' filter pre-selected (higher contrast + saturation makes whiteboard content crisp).

- [ ] **Step 1: Create `app/tools/whiteboard.tsx`**

```typescript
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';

export default function WhiteboardScreen() {
  const { openImport } = useScan();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [scanning, setScanning] = useState(false);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
      });
      if (!scannedImages?.length) {
        setScanning(false);
        return;
      }
      await openImport(scannedImages, 'enhanced');
      router.back();
    } catch {
      Alert.alert('Scan failed', 'Could not scan. Please try again.');
      setScanning(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Whiteboard</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#4FC3F728' }]}>
          <MaterialCommunityIcons name="presentation" size={48} color="#4FC3F7" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Scan a Whiteboard</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Enhanced contrast is applied automatically to make whiteboard content crisp and clear.
        </Text>
        <Pressable
          style={[styles.btn, { opacity: scanning ? 0.6 : 1 }]}
          onPress={handleScan}
          disabled={scanning}
        >
          <MaterialCommunityIcons name="camera" size={20} color="#fff" />
          <Text style={styles.btnText}>{scanning ? 'Scanning…' : 'Start Scan'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#4FC3F7',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
```

- [ ] **Step 2: Wire up the route in tools.tsx**

Find the Whiteboard entry in `app/(tabs)/tools.tsx` and replace `soon: true` with an action:
```typescript
// Before:
{
  id: 'whiteboard',
  icon: 'presentation',
  label: 'Whiteboard',
  color: '#4FC3F7',
  soon: true,
},

// After:
{
  id: 'whiteboard',
  icon: 'presentation',
  label: 'Whiteboard',
  color: '#4FC3F7',
  action: () => router.push('/tools/whiteboard'),
},
```

- [ ] **Step 3: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 4: Commit**
```bash
git add app/tools/whiteboard.tsx app/\(tabs\)/tools.tsx
git commit -m "feat: add Whiteboard scan tool with enhanced filter preset"
```

---

### Task 4: Book Mode tool

**Files:**
- Create: `app/tools/book.tsx`
- Modify: `app/(tabs)/tools.tsx`

Scans a two-page book spread and splits the image at the horizontal midpoint into two separate document pages using `manipulateAsync`.

- [ ] **Step 1: Create `app/tools/book.tsx`**

```typescript
import { useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export default function BookScreen() {
  const { openImport } = useScan();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [scanning, setScanning] = useState(false);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
        maxNumDocuments: 1,
      });
      if (!scannedImages?.length) {
        setScanning(false);
        return;
      }
      const uri = scannedImages[0];
      const { width, height } = await getImageSize(uri);
      const halfWidth = Math.floor(width / 2);

      const [leftResult, rightResult] = await Promise.all([
        manipulateAsync(
          uri,
          [{ crop: { originX: 0, originY: 0, width: halfWidth, height } }],
          { compress: 0.9, format: SaveFormat.JPEG }
        ),
        manipulateAsync(
          uri,
          [{ crop: { originX: halfWidth, originY: 0, width: width - halfWidth, height } }],
          { compress: 0.9, format: SaveFormat.JPEG }
        ),
      ]);

      await openImport([leftResult.uri, rightResult.uri]);
      router.back();
    } catch {
      Alert.alert('Scan failed', 'Could not process book scan. Please try again.');
      setScanning(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Book Mode</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#FFA72628' }]}>
          <MaterialCommunityIcons name="book-open-page-variant" size={48} color="#FFA726" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Scan a Book Spread</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Point the camera at two open pages. The image is automatically split at the centre into two separate pages.
        </Text>
        <Pressable
          style={[styles.btn, { opacity: scanning ? 0.6 : 1 }]}
          onPress={handleScan}
          disabled={scanning}
        >
          <MaterialCommunityIcons name="camera" size={20} color="#fff" />
          <Text style={styles.btnText}>{scanning ? 'Processing…' : 'Scan Spread'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFA726',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
```

- [ ] **Step 2: Wire up the route in tools.tsx**

Find the Book Mode entry in `app/(tabs)/tools.tsx` and replace:
```typescript
// Before:
{
  id: 'book',
  icon: 'book-open-page-variant',
  label: 'Book Mode',
  color: '#FFA726',
  soon: true,
},

// After:
{
  id: 'book',
  icon: 'book-open-page-variant',
  label: 'Book Mode',
  color: '#FFA726',
  action: () => router.push('/tools/book'),
},
```

- [ ] **Step 3: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 4: Commit**
```bash
git add app/tools/book.tsx app/\(tabs\)/tools.tsx
git commit -m "feat: add Book Mode — splits scan at midpoint into two pages"
```

---

### Task 5: AI key storage helpers

**Files:**
- Modify: `lib/storage.ts`

- [ ] **Step 1: Add AI key helpers at the bottom of `lib/storage.ts`**

Append after the last export in the file:
```typescript
// ── AI key ──────────────────────────────────────────────────────────────────
const AI_KEY_STORAGE = '@scan_kit_ai_key';

export async function getAiKey(): Promise<string | null> {
  const val = await AsyncStorage.getItem(AI_KEY_STORAGE);
  return val && val.length > 0 ? val : null;
}

export async function saveAiKey(key: string): Promise<void> {
  return AsyncStorage.setItem(AI_KEY_STORAGE, key);
}

export async function clearAiKey(): Promise<void> {
  return AsyncStorage.removeItem(AI_KEY_STORAGE);
}
```

- [ ] **Step 2: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 3: Commit**
```bash
git add lib/storage.ts
git commit -m "feat: add AI key storage helpers (getAiKey, saveAiKey, clearAiKey)"
```

---

### Task 6: Ask AI tool

**Files:**
- Create: `app/tools/ask-ai.tsx`
- Modify: `app/(tabs)/tools.tsx`

Lets the user pick a document, type a question, and get an answer from Claude. Only the first page (JPEG) of the selected document is sent. The screen has two states: **setup** (no API key stored) and **chat** (key present).

- [ ] **Step 1: Create `app/tools/ask-ai.tsx`**

```typescript
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { useTheme } from '@/contexts/theme-context';
import { getAiKey, saveAiKey, clearAiKey, getDocuments } from '@/lib/storage';
import type { Document } from '@/types/document';

async function askClaude(apiKey: string, imageBase64: string, question: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
            },
            { type: 'text', text: question },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error?.message ?? `API error ${res.status}`);
  }
  const data = await res.json();
  return (data as any).content?.[0]?.text ?? 'No response received.';
}

export default function AskAiScreen() {
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  useEffect(() => {
    getAiKey().then(setApiKey);
    getDocuments().then(docs => setDocuments(docs.filter(d => d.pages.length > 0)));
  }, []);

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed.startsWith('sk-ant-')) {
      Alert.alert('Invalid key', 'Anthropic API keys start with "sk-ant-".');
      return;
    }
    setSavingKey(true);
    await saveAiKey(trimmed);
    setApiKey(trimmed);
    setSavingKey(false);
  };

  const handleClearKey = () => {
    Alert.alert('Change API Key', 'This will remove the stored key.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearAiKey();
          setApiKey(null);
          setKeyInput('');
        },
      },
    ]);
  };

  const handleSend = useCallback(async () => {
    if (!apiKey || !selectedDoc || !question.trim()) return;
    setLoading(true);
    setAnswer(null);
    try {
      const pageUri = selectedDoc.pages[0];
      const base64 = await FileSystem.readAsStringAsync(pageUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const result = await askClaude(apiKey, base64, question.trim());
      setAnswer(result);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Something went wrong. Check your API key.');
    } finally {
      setLoading(false);
    }
  }, [apiKey, selectedDoc, question]);

  const borderColor = isDark ? '#2a2a2a' : '#e0e0e0';
  const inputBg = isDark ? '#1a1a1a' : '#f5f5f5';

  // ── Setup screen (no API key) ─────────────────────────────────────────────
  if (!apiKey) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Ask AI</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.body}>
          <View style={[styles.iconWrap, { backgroundColor: '#CE93D828' }]}>
            <MaterialCommunityIcons name="robot-outline" size={48} color="#CE93D8" />
          </View>
          <Text style={[styles.heading, { color: colors.text }]}>Enter your Anthropic API key</Text>
          <Text style={[styles.sub, { color: colors.faint }]}>
            Ask AI uses the Anthropic API. Get your key at console.anthropic.com. It is stored only on your device and never shared.
          </Text>
          <TextInput
            style={[styles.keyInput, { color: colors.text, borderColor, backgroundColor: inputBg }]}
            placeholder="sk-ant-…"
            placeholderTextColor={colors.faint}
            value={keyInput}
            onChangeText={setKeyInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Pressable
            style={[styles.btn, { backgroundColor: '#CE93D8', opacity: savingKey || !keyInput.trim() ? 0.6 : 1 }]}
            onPress={handleSaveKey}
            disabled={savingKey || !keyInput.trim()}
          >
            <Text style={styles.btnText}>{savingKey ? 'Saving…' : 'Save Key'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Chat screen ───────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Ask AI</Text>
        <Pressable onPress={handleClearKey} style={styles.backBtn}>
          <MaterialCommunityIcons name="key-outline" size={22} color={colors.faint} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 120 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.label, { color: colors.faint }]}>DOCUMENT</Text>
        <Pressable
          style={[styles.picker, { borderColor, backgroundColor: inputBg }]}
          onPress={() => setPickerVisible(true)}
        >
          {selectedDoc ? (
            <View style={styles.pickerRow}>
              <Image source={{ uri: selectedDoc.pages[0] }} style={styles.thumb} />
              <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                {selectedDoc.name}
              </Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          ) : (
            <View style={styles.pickerRow}>
              <MaterialCommunityIcons name="file-document-outline" size={24} color={colors.faint} />
              <Text style={[styles.placeholder, { color: colors.faint }]}>Select a document</Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          )}
        </Pressable>

        <Text style={[styles.label, { color: colors.faint, marginTop: 20 }]}>QUESTION</Text>
        <TextInput
          style={[styles.questionInput, { color: colors.text, borderColor, backgroundColor: inputBg }]}
          placeholder="What does this document say?"
          placeholderTextColor={colors.faint}
          value={question}
          onChangeText={setQuestion}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        <Pressable
          style={[styles.sendBtn, { opacity: !selectedDoc || !question.trim() || loading ? 0.5 : 1 }]}
          onPress={handleSend}
          disabled={!selectedDoc || !question.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <MaterialCommunityIcons name="send" size={18} color="#fff" />
              <Text style={styles.btnText}>Ask</Text>
            </>
          )}
        </Pressable>

        {answer !== null && (
          <View style={[styles.answerBox, { backgroundColor: inputBg, borderColor }]}>
            <Text style={[styles.label, { color: colors.faint }]}>ANSWER</Text>
            <Text style={[styles.answerText, { color: colors.text }]}>{answer}</Text>
          </View>
        )}
      </ScrollView>

      <Modal visible={pickerVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: colors.bg }]}>
          <View style={[styles.header, { paddingTop: 16 }]}>
            <Text style={[styles.title, { color: colors.text }]}>Select Document</Text>
            <Pressable onPress={() => setPickerVisible(false)} style={styles.backBtn}>
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
          <FlatList
            data={documents}
            keyExtractor={d => d.id}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.listItem, { borderBottomColor: borderColor }]}
                onPress={() => { setSelectedDoc(item); setPickerVisible(false); }}
              >
                <Image source={{ uri: item.pages[0] }} style={styles.listThumb} />
                <Text style={[styles.docName, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                  {item.name}
                </Text>
                {selectedDoc?.id === item.id && (
                  <MaterialCommunityIcons name="check-circle" size={22} color="#CE93D8" />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[styles.sub, { color: colors.faint, textAlign: 'center', marginTop: 40 }]}>
                No scanned documents yet.
              </Text>
            }
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  keyInput: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  scroll: { flex: 1 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  picker: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  docName: { flex: 1, fontSize: 15, fontWeight: '500' },
  placeholder: { flex: 1, fontSize: 15 },
  questionInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 80,
  },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#CE93D8',
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 16,
  },
  answerBox: { borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 20, gap: 8 },
  answerText: { fontSize: 15, lineHeight: 22 },
  modal: { flex: 1 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listThumb: { width: 48, height: 48, borderRadius: 6 },
});
```

- [ ] **Step 2: Wire up the route in tools.tsx**

```typescript
// Before:
{
  id: 'ask-ai',
  icon: 'robot-outline',
  label: 'Ask AI',
  color: '#CE93D8',
  soon: true,
},

// After:
{
  id: 'ask-ai',
  icon: 'robot-outline',
  label: 'Ask AI',
  color: '#CE93D8',
  action: () => router.push('/tools/ask-ai'),
},
```

- [ ] **Step 3: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 4: Commit**
```bash
git add app/tools/ask-ai.tsx app/\(tabs\)/tools.tsx
git commit -m "feat: add Ask AI tool — send document page to Claude and ask questions"
```

---

### Task 7: Erase Marks tool

**Files:**
- Create: `app/tools/erase-marks.tsx`
- Modify: `app/(tabs)/tools.tsx`

Applies a high-contrast grayscale preset to all pages of a selected document. The 'bw' filter (`grayscale(1) contrast(2)`) combined with brightness +30 and contrast +30 adjustments makes pencil and lightly-inked marks appear white. The changes persist via `updateDocument` and affect the document viewer and PDF exports through the existing CSS filter pipeline in `lib/filters.ts`.

Note: `updateDocument` takes a full `Document` object. Spread the existing doc and override filters/adjustments/updatedAt.

- [ ] **Step 1: Create `app/tools/erase-marks.tsx`**

```typescript
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, updateDocument } from '@/lib/storage';
import type { Document, PageAdjustment } from '@/types/document';

const ERASE_FILTER = 'bw' as const;
const ERASE_ADJUSTMENT: PageAdjustment = { brightness: 30, contrast: 30, saturation: 0 };

export default function EraseMarksScreen() {
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    getDocuments().then(docs => setDocuments(docs.filter(d => d.pages.length > 0)));
  }, []);

  const handleApply = useCallback(async () => {
    if (!selectedDoc) return;
    setApplying(true);
    setDone(false);
    try {
      const pageCount = selectedDoc.pages.length;
      await updateDocument({
        ...selectedDoc,
        filters: Array(pageCount).fill(ERASE_FILTER),
        adjustments: Array(pageCount).fill(ERASE_ADJUSTMENT),
        updatedAt: Date.now(),
      });
      setDone(true);
    } catch {
      Alert.alert('Error', 'Failed to apply. Please try again.');
    } finally {
      setApplying(false);
    }
  }, [selectedDoc]);

  const borderColor = isDark ? '#2a2a2a' : '#e0e0e0';
  const inputBg = isDark ? '#1a1a1a' : '#f5f5f5';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Erase Marks</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: '#FF8A6528' }]}>
          <MaterialCommunityIcons name="eraser-variant" size={48} color="#FF8A65" />
        </View>
        <Text style={[styles.heading, { color: colors.text }]}>Remove Pencil & Light Marks</Text>
        <Text style={[styles.sub, { color: colors.faint }]}>
          Applies a high-contrast grayscale filter to make light pencil and pen marks disappear. Affects the document view and PDF exports.
        </Text>

        <Pressable
          style={[styles.picker, { borderColor, backgroundColor: inputBg }]}
          onPress={() => { setDone(false); setPickerVisible(true); }}
        >
          {selectedDoc ? (
            <View style={styles.pickerRow}>
              <Image source={{ uri: selectedDoc.pages[0] }} style={styles.thumb} />
              <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                {selectedDoc.name}
              </Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          ) : (
            <View style={styles.pickerRow}>
              <MaterialCommunityIcons name="file-document-outline" size={24} color={colors.faint} />
              <Text style={[styles.placeholder, { color: colors.faint }]}>Select a document</Text>
              <MaterialCommunityIcons name="chevron-down" size={20} color={colors.faint} />
            </View>
          )}
        </Pressable>

        {done && (
          <View style={[styles.successRow, { backgroundColor: '#66BB6A20' }]}>
            <MaterialCommunityIcons name="check-circle" size={18} color="#66BB6A" />
            <Text style={{ color: '#66BB6A', fontWeight: '600' }}>Applied to all pages</Text>
          </View>
        )}

        <Pressable
          style={[styles.applyBtn, { opacity: !selectedDoc || applying ? 0.5 : 1 }]}
          onPress={handleApply}
          disabled={!selectedDoc || applying}
        >
          <MaterialCommunityIcons name="eraser-variant" size={20} color="#fff" />
          <Text style={styles.btnText}>{applying ? 'Applying…' : 'Apply to All Pages'}</Text>
        </Pressable>
      </View>

      <Modal visible={pickerVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: colors.bg }]}>
          <View style={[styles.header, { paddingTop: 16 }]}>
            <Text style={[styles.title, { color: colors.text }]}>Select Document</Text>
            <Pressable onPress={() => setPickerVisible(false)} style={styles.backBtn}>
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
          <FlatList
            data={documents}
            keyExtractor={d => d.id}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.listItem, { borderBottomColor: borderColor }]}
                onPress={() => { setSelectedDoc(item); setPickerVisible(false); }}
              >
                <Image source={{ uri: item.pages[0] }} style={styles.listThumb} />
                <Text style={[styles.docName, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                  {item.name}
                </Text>
                {selectedDoc?.id === item.id && (
                  <MaterialCommunityIcons name="check-circle" size={22} color="#FF8A65" />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[styles.sub, { color: colors.faint, textAlign: 'center', marginTop: 40 }]}>
                No scanned documents yet.
              </Text>
            }
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  heading: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  picker: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  docName: { flex: 1, fontSize: 15, fontWeight: '500' },
  placeholder: { flex: 1, fontSize: 15 },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    width: '100%',
    justifyContent: 'center',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FF8A65',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  modal: { flex: 1 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listThumb: { width: 48, height: 48, borderRadius: 6 },
});
```

- [ ] **Step 2: Wire up the route in tools.tsx**

```typescript
// Before:
{
  id: 'erase-marks',
  icon: 'eraser-variant',
  label: 'Erase Marks',
  color: '#FF8A65',
  soon: true,
},

// After:
{
  id: 'erase-marks',
  icon: 'eraser-variant',
  label: 'Erase Marks',
  color: '#FF8A65',
  action: () => router.push('/tools/erase-marks'),
},
```

- [ ] **Step 3: Verify TypeScript compiles**
```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 4: Commit**
```bash
git add app/tools/erase-marks.tsx app/\(tabs\)/tools.tsx
git commit -m "feat: add Erase Marks tool — high-contrast bw preset removes light marks from documents"
```
