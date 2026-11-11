/**
 * Format an estimated USD cost for display: "$0.42", "$12.30", "$1,204".
 * Returns null when there is no cost to show (unknown or zero), so callers
 * can skip rendering.
 */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return '<$0.01';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}
