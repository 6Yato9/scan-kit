// app/tools/ask-ai.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useTheme } from '@/contexts/theme-context';
import { getAiKey, saveAiKey, clearAiKey, getDocuments } from '@/lib/storage';
import type { Document } from '@/types/document';

// Claude vision accepts up to 20 images per message; cap to stay well within limits.
const MAX_PAGES_PER_REQUEST = 20;
// Hard timeout for the full request — if the network stalls (or the user
// backgrounds the app), we don't want to leave the loading spinner forever.
const REQUEST_TIMEOUT_MS = 60_000;

async function askClaude(
  apiKey: string,
  imagesBase64: string[],
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const imageBlocks = imagesBase64.map(data => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
  }));
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
          content: [...imageBlocks, { type: 'text', text: question }],
        },
      ],
    }),
    signal,
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
  const abortRef = useRef<AbortController | null>(null);

  useFocusEffect(
    useCallback(() => {
      getAiKey().then(setApiKey);
      getDocuments().then(docs => {
        const filtered = docs.filter(d => d.pages.length > 0 && !d.pdfUri);
        setDocuments(filtered);
        setSelectedDoc(prev => (prev && filtered.some(d => d.id === prev.id) ? prev : null));
      });
    }, [])
  );

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed.startsWith('sk-ant-')) {
      Alert.alert('Invalid key', 'Anthropic API keys start with "sk-ant-".');
      return;
    }
    setSavingKey(true);
    try {
      await saveAiKey(trimmed);
      setApiKey(trimmed);
    } catch {
      Alert.alert('Error', 'Failed to save key. Please try again.');
    } finally {
      setSavingKey(false);
    }
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

    // Create a fresh AbortController for this request. The timeout will trip
    // it if the network stalls; the Cancel button calls abortRef.current.abort().
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const pages = selectedDoc.pages.slice(0, MAX_PAGES_PER_REQUEST);
      const truncated = selectedDoc.pages.length > MAX_PAGES_PER_REQUEST;
      // Read pages sequentially and downscale before encoding so we don't hold
      // 30-60MB of base64 in memory for a high-res multi-page doc.
      const images: string[] = [];
      for (const uri of pages) {
        if (ctrl.signal.aborted) throw new Error('cancelled');
        // Strip any cache-bust suffix.
        const sourcePath = uri.split('?')[0];
        // Downscale to ~1600px wide and re-encode at quality 0.7 — Claude's
        // vision model doesn't need the full resolution to read a page.
        const resized = await manipulateAsync(
          sourcePath,
          [{ resize: { width: 1600 } }],
          { compress: 0.7, format: SaveFormat.JPEG },
        );
        const b64 = await FileSystem.readAsStringAsync(resized.uri, { encoding: 'base64' });
        images.push(b64);
      }
      const result = await askClaude(apiKey, images, question.trim(), ctrl.signal);
      setAnswer(
        truncated
          ? `(Only the first ${MAX_PAGES_PER_REQUEST} pages were sent — the rest were skipped.)\n\n${result}`
          : result,
      );
    } catch (err: any) {
      // Don't alert on a user-initiated cancel.
      const name = err?.name;
      const msg = err?.message ?? '';
      if (name === 'AbortError' || msg === 'cancelled') {
        // Silently swallow.
      } else if (ctrl.signal.aborted) {
        Alert.alert('Timed out', 'The request took too long. Check your connection and try again.');
      } else {
        Alert.alert('Error', msg || 'Something went wrong. Check your API key.');
      }
    } finally {
      clearTimeout(timeoutId);
      if (abortRef.current === ctrl) abortRef.current = null;
      setLoading(false);
    }
  }, [apiKey, selectedDoc, question]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Cancel any in-flight request when the screen unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const borderColor = isDark ? '#2a2a2a' : '#e0e0e0';
  const inputBg = isDark ? '#1a1a1a' : '#f5f5f5';

  // ── Setup screen (no API key) ─────────────────────────────────────────────
  if (!apiKey) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.bg }]}
      >
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
      </KeyboardAvoidingView>
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
              <Image source={{ uri: `${selectedDoc.pages[0]}?v=${selectedDoc.updatedAt}` }} style={styles.thumb} />
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

        {loading && (
          <Pressable
            style={[styles.sendBtn, { backgroundColor: colors.secondary, marginTop: 8 }]}
            onPress={handleCancel}
          >
            <MaterialCommunityIcons name="close" size={18} color={colors.text} />
            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
          </Pressable>
        )}

        {answer !== null && (
          <View style={[styles.answerBox, { backgroundColor: inputBg, borderColor }]}>
            <Text style={[styles.label, { color: colors.faint }]}>ANSWER</Text>
            <Text style={[styles.answerText, { color: colors.text }]}>{answer}</Text>
          </View>
        )}
      </ScrollView>

      <Modal visible={pickerVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerVisible(false)}>
        <View style={[styles.modal, { backgroundColor: colors.bg }]}>
          {/* On iOS pageSheet, the parent already insets us; on Android we need to push past the status bar. */}
          <View style={[styles.header, { paddingTop: Platform.OS === 'android' ? insets.top + 16 : 16 }]}>
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
                onPress={() => { setSelectedDoc(item); setAnswer(null); setPickerVisible(false); }}
              >
                <Image source={{ uri: `${item.pages[0]}?v=${item.updatedAt}` }} style={styles.listThumb} />
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
