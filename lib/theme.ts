// lib/theme.ts
export type ThemePreference = 'light' | 'dark' | 'system';

export type ThemeColors = {
  bg: string;
  card: string;
  input: string;
  text: string;
  subtext: string;
  muted: string;
  faint: string;
  border: string;
  separator: string;
  placeholder: string;
  accent: string;
  accentLight: string;
  danger: string;
  dangerBg: string;
  dangerBorder: string;
  actionBtnBg: string;
  secondary: string;        // secondary button bg (e.g. Retake)
};

export const Colors: Record<'light' | 'dark', ThemeColors> = {
  light: {
    bg: '#f5f5f5',
    card: '#ffffff',
    input: '#ebebeb',
    text: '#1a1a1a',
    subtext: '#555',
    muted: '#888',
    faint: '#999',
    border: '#e8e8e8',
    separator: '#f0f0f0',
    placeholder: '#e8e8e8',
    accent: '#0a7ea4',
    accentLight: '#e8f5fa',
    danger: '#cc0000',
    dangerBg: '#fff0f0',
    dangerBorder: '#ffc5c5',
    actionBtnBg: '#f5f5f5',
    secondary: '#f0f0f0',
  },
  dark: {
    bg: '#111111',
    card: '#1e1e1e',
    input: '#2a2a2a',
    text: '#f0f0f0',
    subtext: '#aaa',
    muted: '#888',
    faint: '#666',
    border: '#333333',
    separator: '#2a2a2a',
    placeholder: '#333333',
    accent: '#4ec6e0',
    accentLight: '#1a3d4a',
    danger: '#ff6b6b',
    dangerBg: '#3d1a1a',
    dangerBorder: '#7a3333',
    actionBtnBg: '#2a2a2a',
    secondary: '#2a2a2a',
  },
};
