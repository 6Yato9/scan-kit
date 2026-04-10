// lib/filters.ts
import { PageFilter } from '../types/document';

/** Returns a React Native `filter` style string, or undefined for 'original'. */
export function filterStyle(filter?: PageFilter): string | undefined {
  switch (filter) {
    case 'grayscale': return 'grayscale(1)';
    case 'bw':        return 'grayscale(1) contrast(2)';
    case 'enhanced':  return 'contrast(1.3) saturate(1.3)';
    default:          return undefined;
  }
}

/** Returns a CSS filter string for use in PDF HTML <img> tags. */
export function filterCss(filter?: PageFilter): string {
  switch (filter) {
    case 'grayscale': return 'grayscale(100%)';
    case 'bw':        return 'grayscale(100%) contrast(200%)';
    case 'enhanced':  return 'contrast(130%) saturate(130%)';
    default:          return 'none';
  }
}
