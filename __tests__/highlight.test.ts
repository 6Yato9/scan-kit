import { highlightRuns } from '@/lib/highlight';

const bold = (runs: ReturnType<typeof highlightRuns>) => runs.filter(r => r.match).map(r => r.text);

describe('highlightRuns', () => {
  it('returns the whole text as one plain run without a query', () => {
    expect(highlightRuns('Invoice total', '')).toEqual([{ text: 'Invoice total', match: false }]);
    expect(highlightRuns('Invoice total', undefined)).toEqual([{ text: 'Invoice total', match: false }]);
    expect(highlightRuns('', 'x')).toEqual([]);
  });

  it('marks case-insensitive matches and keeps the original casing', () => {
    const runs = highlightRuns('Rent is due on the 1st. RENT includes water.', 'rent');
    expect(bold(runs)).toEqual(['Rent', 'RENT']);
    expect(runs.map(r => r.text).join('')).toBe('Rent is due on the 1st. RENT includes water.');
  });

  it('matches every term and merges adjacent hits', () => {
    const runs = highlightRuns('Total due: $1,284.50', 'total due');
    expect(bold(runs)).toEqual(['Total', 'due']);
    expect(bold(highlightRuns('abcabc', 'abc'))).toEqual(['abcabc']);
  });

  it('ignores accents in either direction', () => {
    expect(bold(highlightRuns('Café receipt', 'cafe'))).toEqual(['Café']);
    expect(bold(highlightRuns('Cafe receipt', 'café'))).toEqual(['Cafe']);
  });

  it('keeps a decomposed accent with its letter', () => {
    const text = 'Café receipt';
    const runs = highlightRuns(text, 'cafe');
    expect(bold(runs)).toEqual(['Café']);
    expect(runs.map(r => r.text).join('')).toBe(text);
  });
});
