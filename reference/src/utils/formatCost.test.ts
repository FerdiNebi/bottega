import { describe, it, expect } from 'vitest';
import { formatCost } from './formatCost';

describe('formatCost', () => {
  it('shows dollars with cents', () => {
    expect(formatCost(0.4213)).toBe('$0.42');
    expect(formatCost(12.3)).toBe('$12.30');
  });

  it('rounds large totals to whole dollars', () => {
    expect(formatCost(1204.4)).toBe('$1,204');
  });

  it('marks tiny costs instead of showing $0.00', () => {
    expect(formatCost(0.0004)).toBe('<$0.01');
  });

  it('returns null when there is nothing to show', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost(0)).toBeNull();
    expect(formatCost(Number.NaN)).toBeNull();
  });
});
