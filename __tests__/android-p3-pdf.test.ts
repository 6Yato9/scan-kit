// Android port phase 3: the cross-platform text prompt and the PDF viewer gate.
import { Alert, Platform } from 'react-native';
import {
  answerTextPromptForTests,
  currentTextPromptForTests,
  promptText,
  showTextPrompt,
} from '../components/text-prompt';
import { hasNativePdfView } from '../modules/vision-ocr/src/PdfDocumentView';

jest.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@/components/lock-gate', () => ({ useAppLocked: () => false }));

const flush = () => new Promise(r => setTimeout(r, 0));

describe('text prompt', () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    while (currentTextPromptForTests()) answerTextPromptForTests(null);
    jest.restoreAllMocks();
  });

  it('iOS keeps Alert.prompt: Cancel, then the preferred confirm button, secure-text', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const prompt = jest.fn();
    (Alert as unknown as { prompt: unknown }).prompt = prompt;
    const onSubmit = jest.fn();
    showTextPrompt({ title: 'Enter the PDF’s password', message: 'msg', secure: true, confirmLabel: 'Unlock' }, onSubmit);
    expect(prompt).toHaveBeenCalledTimes(1);
    const [title, message, buttons, type] = prompt.mock.calls[0];
    expect(title).toBe('Enter the PDF’s password');
    expect(message).toBe('msg');
    expect(type).toBe('secure-text');
    // Exactly the buttons the screens passed before (no onPress on Cancel).
    expect(buttons[0]).toEqual({ text: 'Cancel', style: 'cancel' });
    expect(buttons[1].text).toBe('Unlock');
    expect(buttons[1].isPreferred).toBe(true);
    buttons[1].onPress(undefined);
    expect(onSubmit).toHaveBeenCalledWith('');
    buttons[1].onPress('s3cret');
    expect(onSubmit).toHaveBeenLastCalledWith('s3cret');
    // Nothing is queued for the Android dialog.
    expect(currentTextPromptForTests()).toBeNull();
  });

  it('iOS: a cancel handler is attached to Cancel only when given', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const prompt = jest.fn();
    (Alert as unknown as { prompt: unknown }).prompt = prompt;
    const onCancel = jest.fn();
    showTextPrompt({ title: 't' }, jest.fn(), onCancel);
    const [, , buttons, type] = prompt.mock.calls[0];
    expect(type).toBe('plain-text');
    expect(buttons[0].text).toBe('Cancel');
    buttons[0].onPress();
    expect(onCancel).toHaveBeenCalled();
    expect(buttons[1].text).toBe('OK');
  });

  it('Android shows the in-app dialog and resolves what was typed', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const prompt = jest.fn();
    (Alert as unknown as { prompt: unknown }).prompt = prompt;
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    showTextPrompt({ title: 'Enter the PDF’s password', secure: true, confirmLabel: 'Unlock' }, onSubmit, onCancel);
    expect(prompt).not.toHaveBeenCalled();
    expect(currentTextPromptForTests()).toMatchObject({ title: 'Enter the PDF’s password', secure: true, confirmLabel: 'Unlock', cancelLabel: 'Cancel' });
    answerTextPromptForTests('pw');
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('pw');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Android: Cancel calls onCancel; an empty answer is still an answer', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    showTextPrompt({ title: 'a' }, onSubmit, onCancel);
    answerTextPromptForTests(null);
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    showTextPrompt({ title: 'b' }, onSubmit, onCancel);
    answerTextPromptForTests('');
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('shows one prompt at a time, in order', async () => {
    const first = promptText({ title: 'first' });
    const second = promptText({ title: 'second' });
    expect(currentTextPromptForTests()?.title).toBe('first');
    answerTextPromptForTests('1');
    expect(currentTextPromptForTests()?.title).toBe('second');
    answerTextPromptForTests(null);
    await expect(first).resolves.toBe('1');
    await expect(second).resolves.toBeNull();
    expect(currentTextPromptForTests()).toBeNull();
  });
});

describe('hasNativePdfView on Android', () => {
  const withView = { getViewConfig: () => ({ validAttributes: {} }) };
  it('is true only for a build whose module says it holds the real viewer', () => {
    expect(hasNativePdfView(withView, 'android', true)).toBe(true);
    // Phase-2 builds: a placeholder in the slot.
    expect(hasNativePdfView(withView, 'android', false)).toBe(false);
    // The view itself missing.
    expect(hasNativePdfView({ getViewConfig: () => null }, 'android', true)).toBe(false);
    // iOS ignores the Android flag.
    expect(hasNativePdfView(withView, 'ios', false)).toBe(true);
  });
});
