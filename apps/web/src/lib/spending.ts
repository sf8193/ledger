import { isDemoMode } from '../hooks/useDemo';

export const CATEGORY_COLORS = [
  '#EF4444', '#F97316', '#FBBF24', '#A3E635', '#34D399',
  '#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899', '#F43F5E',
  '#6366F1', '#14B8A6', '#D946EF', '#FB923C', '#84CC16',
  '#06B6D4',
];

export function formatCurrency(amount: number): string {
  if (isDemoMode()) return '$••••';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export interface SpendingBreakdown {
  breakdown: Array<{
    month: string;
    categoryId: string;
    categoryName: string;
    amount: number;
  }>;
  owners: string[];
  allCategories: string[];
}

export interface SpendingChartData {
  barData: Array<Record<string, string | number>>;
  pieData: Array<{ name: string; value: number }>;
  categories: string[];
  colorMap: Record<string, string>;
}

export function transformSpendingData(data: SpendingBreakdown): SpendingChartData | null {
  if (!data.breakdown?.length) return null;

  const months = [...new Set(data.breakdown.map(r => r.month))].sort();
  const categoryTotals = new Map<string, number>();
  for (const r of data.breakdown) {
    categoryTotals.set(r.categoryName, (categoryTotals.get(r.categoryName) ?? 0) + Number(r.amount));
  }
  const categories = [...new Set(data.breakdown.map(r => r.categoryName))].sort((a, b) => (categoryTotals.get(b) ?? 0) - (categoryTotals.get(a) ?? 0));
  const globalCategories = data.allCategories ?? categories;
  const colorMap = Object.fromEntries(
    globalCategories.map((c, i) => [c, CATEGORY_COLORS[i % CATEGORY_COLORS.length]])
  );

  const barData = months.map(m => {
    const row: Record<string, string | number> = {
      month: new Date(m + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    };
    for (const r of data.breakdown.filter(b => b.month === m)) {
      const amt = Number(r.amount);
      row[r.categoryName] = Math.max(amt, 0);
      if (amt < 0) row[`_raw:${r.categoryName}`] = amt;
    }
    return row;
  });

  const pieData = categories.map(c => ({
    name: c,
    value: data.breakdown
      .filter(r => r.categoryName === c)
      .reduce((s, r) => s + Number(r.amount), 0),
  })).filter(d => d.value > 0).sort((a, b) => b.value - a.value);

  return { barData, pieData, categories, colorMap };
}
