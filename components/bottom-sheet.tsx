// components/bottom-sheet.tsx
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  transparentBackdrop?: boolean;
};

export function BottomSheet({ visible, onClose, children, transparentBackdrop }: Props) {
  const { colors } = useTheme();
  // RN Modal warns + breaks Android hardware back when onRequestClose is undefined.
  // Pass a no-op when the sheet is intentionally non-dismissable (e.g. while a
  // long-running export is in flight) so the warning + back-button breakage go away.
  const noop = () => {};
  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={onClose ?? noop}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          style={[styles.backdrop, transparentBackdrop && styles.backdropTransparent]}
          onPress={() => {
            if (!onClose) return;
            Keyboard.dismiss();
            onClose();
          }}
        />
        <View style={[styles.sheet, { backgroundColor: colors.card }]}>{children}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  backdropTransparent: { backgroundColor: 'transparent' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 44,
  },
});
