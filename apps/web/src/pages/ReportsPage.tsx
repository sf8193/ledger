import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { QueryError } from '../components/QueryState';
import { CATEGORY_COLORS, formatCurrency, transformSpendingData } from '../lib/spending';
import { isDemoMode, demoText } from '../hooks/useDemo';
import type { SpendingBreakdown } from '../lib/spending';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { DateRangePicker } from '../components/DateRangePicker';
import { TransactionDetail } from '../components/TransactionDetail';
import {
  BarChart, Bar, PieChart, Pie, Cell, Line, ComposedChart, Sankey,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';

type Tab = 'cashflow' | 'spending' | 'income' | 'sankey';

interface SankeyData {
  nodes: Array<{ name: string }>;
  links: Array<{ source: number; target: number; value: number }>;
}

interface CashFlowData {
  data: Array<{ month: string; income: number; expenses: number; savings: number }>;
  totalIncome: number;
  totalExpenses: number;
  savings: number;
  owners: string[];
}

interface JournalLine {
  id: string;
  journal_entry_id: string;
  account_id: string;
  amount: number;
  account_name: string;
  account_type: string;
}

interface CategoryTransaction {
  id: string;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  owner: string | null;
  notes: string | null;
  is_verified: boolean;
  source: string | null;
  exclude_from_totals?: boolean | null;
  reimbursement_status?: 'pending' | 'reimbursed' | null;
  categorized_by?: string | null;
  lines: JournalLine[];
  category?: JournalLine | null;
  tags?: Array<{ id: string; name: string }>;
}

interface DrilldownCategory {
  id: string;
  name: string;
  type: 'income' | 'expense';
}

function aggregateCategories(breakdown: SpendingBreakdown['breakdown']) {
  const totals = new Map<string, { id: string; name: string; amount: number }>();
  for (const row of breakdown) {
    const existing = totals.get(row.categoryName);
    if (existing) {
      existing.amount += Number(row.amount);
    } else {
      totals.set(row.categoryName, { id: row.categoryId, name: row.categoryName, amount: Number(row.amount) });
    }
  }
  const cats = [...totals.values()].filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = cats.reduce((s, c) => s + c.amount, 0);
  return cats.map(c => ({ ...c, pct: total > 0 ? (c.amount / total) * 100 : 0 }));
}

// Group transactions by date for the detail view
function groupByDate(txns: CategoryTransaction[]) {
  const groups: Array<{ date: string; label: string; dayTotal: number; txns: CategoryTransaction[] }> = [];
  let currentDate = '';
  for (const txn of txns) {
    const d = String(txn.date).slice(0, 10);
    if (d !== currentDate) {
      currentDate = d;
      groups.push({
        date: d,
        label: new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        dayTotal: 0,
        txns: [],
      });
    }
    const group = groups[groups.length - 1];
    group.txns.push(txn);
    group.dayTotal += Math.abs(txn.amount);
  }
  return groups;
}

export function ReportsPage() {
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'cashflow';
  const [tab, setTab] = useState<Tab>(['cashflow', 'spending', 'income', 'sankey'].includes(initialTab) ? initialTab : 'cashflow');
  const parsedMonths = Number(searchParams.get('months'));
  const [months, setMonths] = useState<number | 'CUSTOM'>(
    [1, 3, 6, 12].includes(parsedMonths) ? parsedMonths : 12
  );
  // Sync months from URL when search params change (e.g. back/forward navigation)
  useEffect(() => {
    const urlMonths = Number(searchParams.get('months'));
    if ([1, 3, 6, 12].includes(urlMonths)) setMonths(urlMonths);
  }, [searchParams]);

  const [owner, setOwner] = useState<string | null>(null);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [drilldown, setDrilldown] = useState<DrilldownCategory | null>(null);
  // For spending/income tab chart click
  const [selectedCategory, setSelectedCategory] = useState<{ name: string; id: string } | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<CategoryTransaction | null>(null);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (months === 'CUSTOM') {
      if (customFrom) params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    } else {
      params.set('months', String(months));
    }
    if (owner) params.set('owner', owner);
    return params.toString();
  }, [months, owner, customFrom, customTo]);

  // Cash flow totals
  const { data: cashflow, isLoading: cfLoading, isError: cfError, error: cfErr, refetch: cfRefetch } = useQuery<CashFlowData>({
    queryKey: ['cashflow', queryParams],
    queryFn: () => apiFetch(`/dashboard/cashflow?${queryParams}`),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: tab === 'cashflow',
  });

  // Spending breakdown
  const { data: spendingData, isLoading: spLoading, isError: spError, error: spErr, refetch: spRefetch } = useQuery<SpendingBreakdown>({
    queryKey: ['spending-breakdown', queryParams],
    queryFn: () => apiFetch(`/dashboard/spending-breakdown?${queryParams}`),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: tab === 'cashflow' || tab === 'spending' || tab === 'sankey',
  });

  // Income breakdown
  const { data: incomeData, isLoading: incLoading, isError: incError, error: incErr, refetch: incRefetch } = useQuery<SpendingBreakdown>({
    queryKey: ['income-breakdown', queryParams],
    queryFn: () => apiFetch(`/dashboard/income-breakdown?${queryParams}`),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: tab === 'cashflow' || tab === 'income' || tab === 'sankey',
  });

  // Sankey flow data
  const { data: sankeyData, isLoading: skLoading, isError: skError, error: skErr, refetch: skRefetch } = useQuery<SankeyData>({
    queryKey: ['sankey', queryParams],
    queryFn: () => apiFetch(`/dashboard/sankey?${queryParams}`),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: tab === 'sankey',
  });

  // Active breakdown for spending/income tab charts
  const breakdownData = tab === 'income' ? incomeData : spendingData;
  const chartData = useMemo(() => breakdownData ? transformSpendingData(breakdownData) : null, [breakdownData]);

  const categoryIdMap = useMemo(() => {
    if (!breakdownData) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const row of breakdownData.breakdown) {
      if (!map.has(row.categoryName)) map.set(row.categoryName, row.categoryId);
    }
    return map;
  }, [breakdownData]);

  // Combined name→{id, type} map for Sankey node clicks
  const sankeyCategoryMap = useMemo(() => {
    const map = new Map<string, { id: string; type: 'income' | 'expense' }>();
    if (incomeData) {
      for (const row of incomeData.breakdown) {
        if (!map.has(row.categoryName)) map.set(row.categoryName, { id: row.categoryId, type: 'income' });
      }
    }
    if (spendingData) {
      for (const row of spendingData.breakdown) {
        if (!map.has(row.categoryName)) map.set(row.categoryName, { id: row.categoryId, type: 'expense' });
      }
    }
    return map;
  }, [incomeData, spendingData]);

  // Per-category color map for Sankey nodes
  const sankeyColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    let idx = 0;
    // Income sources get green shades
    const greenPalette = ['#34d399', '#10b981', '#059669', '#047857', '#065f46', '#6ee7b7', '#a7f3d0'];
    if (incomeData) {
      const names = [...new Set(incomeData.breakdown.map(r => r.categoryName))];
      for (const name of names) {
        map[name] = greenPalette[idx % greenPalette.length];
        idx++;
      }
    }
    // Expense categories get the standard palette
    idx = 0;
    if (spendingData) {
      const names = [...new Set(spendingData.breakdown.map(r => r.categoryName))];
      for (const name of names) {
        map[name] = CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
        idx++;
      }
    }
    return map;
  }, [incomeData, spendingData]);

  const handleChartCategoryClick = (name: string) => {
    const id = categoryIdMap.get(name);
    if (!id) return;
    setSelectedCategory(prev => prev?.name === name ? null : { name, id });
  };

  // Cash flow chart data
  const cfChartData = useMemo(() => {
    if (!cashflow?.data?.length) return null;
    return cashflow.data.map(d => ({
      month: new Date(d.month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      Income: d.income,
      Expenses: d.expenses,
      Savings: d.savings,
    }));
  }, [cashflow]);

  // Aggregated categories for cashflow tab lists
  const incomeCats = useMemo(() => incomeData ? aggregateCategories(incomeData.breakdown) : [], [incomeData]);
  const expenseCats = useMemo(() => spendingData ? aggregateCategories(spendingData.breakdown) : [], [spendingData]);

  // Per-month data for drilldown category bar chart
  const drilldownMonthly = useMemo(() => {
    if (!drilldown) return null;
    const source = drilldown.type === 'income' ? incomeData : spendingData;
    if (!source) return null;
    const rows = source.breakdown.filter(r => r.categoryId === drilldown.id);
    if (!rows.length) return null;
    return rows
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(r => ({
        month: new Date(r.month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        amount: Number(r.amount),
      }));
  }, [drilldown, incomeData, spendingData]);

  // Transaction drill-down
  const activeDrillId = drilldown?.id ?? selectedCategory?.id;
  const { data: categoryTxns } = useQuery<{ data: CategoryTransaction[] }>({
    queryKey: ['category-txns', activeDrillId, queryParams],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('category_id', activeDrillId!);
      params.set('limit', '200');
      if (months !== 'CUSTOM') {
        const start = new Date();
        start.setMonth(start.getMonth() - months);
        params.set('start_date', start.toISOString().slice(0, 10));
      } else {
        if (customFrom) params.set('start_date', customFrom);
        if (customTo) params.set('end_date', customTo);
      }
      if (owner) params.set('owner', owner);
      return apiFetch(`/transactions?${params}`);
    },
    enabled: !!activeDrillId,
  });

  const owners = cashflow?.owners ?? spendingData?.owners ?? incomeData?.owners ?? [];

  const isLoading = tab === 'cashflow' ? cfLoading : tab === 'spending' ? spLoading : tab === 'income' ? incLoading : skLoading;
  const isError = tab === 'cashflow' ? cfError : tab === 'spending' ? spError : tab === 'income' ? incError : skError;
  const error = tab === 'cashflow' ? cfErr : tab === 'spending' ? spErr : tab === 'income' ? incErr : skErr;
  const refetch = tab === 'cashflow' ? cfRefetch : tab === 'spending' ? spRefetch : tab === 'income' ? incRefetch : skRefetch;

  if (isError) return <QueryError message={error?.message || 'Failed to load'} onRetry={() => refetch()} />;

  // ─── Category Detail View ───
  if (drilldown) {
    const drilldownTotal = drilldownMonthly?.reduce((s, d) => s + d.amount, 0) ?? 0;
    const txnCount = categoryTxns?.data?.length ?? 0;
    const barColor = drilldown.type === 'income' ? '#34d399' : '#f87171';
    const grouped = categoryTxns?.data ? groupByDate(categoryTxns.data.filter(t => t.amount !== 0)) : [];

    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setDrilldown(null)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-semibold text-white">{drilldown.name}</h2>
        </div>

        {/* Per-month bar chart */}
        {drilldownMonthly && drilldownMonthly.length > 1 && (
          <div className="bg-surface rounded-xl border border-border p-5 mb-6">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={drilldownMonthly}>
                <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => isDemoMode() ? '$••••' : `$${(v/1000).toFixed(0)}k`} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ background: 'rgb(45 52 65)', border: '1px solid rgb(80 90 110)', borderRadius: 8, fontSize: 12, color: '#f1f5f9', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                  formatter={(value: number) => [formatCurrency(value), drilldown.name]}
                />
                <Bar dataKey="amount" fill={barColor} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Transactions grouped by date */}
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-white">Transactions</h3>
            <span className="text-xs text-slate-500">
              {txnCount > 0 && `${txnCount} transactions · ${formatCurrency(drilldownTotal)}`}
            </span>
          </div>

          {grouped.length > 0 ? (
            <div className="space-y-4">
              {grouped.map(group => (
                <div key={group.date}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-slate-500">{group.label}</span>
                    <span className="text-xs tabular-nums text-slate-600">{formatCurrency(group.dayTotal)}</span>
                  </div>
                  <div className="divide-y divide-border/50">
                    {group.txns.map(txn => (
                      <div key={txn.id} onClick={() => setSelectedEntry(txn)} className="flex items-center justify-between py-2.5 cursor-pointer hover:bg-white/[0.02] transition-colors rounded px-1 -mx-1">
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{txn.merchant_name || txn.description}</div>
                        </div>
                        <div className="text-sm tabular-nums text-slate-400 flex-shrink-0 ml-3">
                          {formatCurrency(Math.abs(txn.amount))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          )}
        </div>

        {selectedEntry && (
          <TransactionDetail
            key={selectedEntry.id}
            entry={selectedEntry}
            onClose={() => setSelectedEntry(null)}
          />
        )}
      </div>
    );
  }

  // Color for category rows
  const getCatColor = (index: number, type: 'income' | 'expense') => {
    if (type === 'income') {
      const greens = ['#34d399', '#10b981', '#059669', '#047857', '#065f46'];
      return greens[index % greens.length];
    }
    const reds = ['#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b'];
    return reds[index % reds.length];
  };

  const renderCategoryRow = (cat: { id: string; name: string; amount: number; pct: number }, index: number, type: 'income' | 'expense') => {
    const color = getCatColor(index, type);
    return (
      <button
        key={cat.id}
        onClick={() => setDrilldown({ id: cat.id, name: cat.name, type })}
        className="w-full text-left group"
      >
        <div className="relative rounded-lg overflow-hidden">
          <div
            className="absolute inset-0 opacity-20 rounded-lg"
            style={{ width: `${Math.max(cat.pct, 2)}%`, background: color }}
          />
          <div className="relative flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-white truncate">{cat.name}</span>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm tabular-nums text-white">{formatCurrency(cat.amount)}</span>
              <span className="text-xs tabular-nums text-slate-500 w-12 text-right">{cat.pct.toFixed(1)}%</span>
              <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors" />
            </div>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-6">Reports</h2>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 bg-surface rounded-lg p-1 w-fit border border-border">
        {([['cashflow', 'Cash Flow'], ['spending', 'Spending'], ['income', 'Income'], ['sankey', 'Flow']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setTab(key); setSelectedCategory(null); setDrilldown(null); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? 'bg-primary/15 text-primary'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-end gap-2 flex-wrap mb-4">
        {owners.length > 1 && (
          <select
            value={owner || ''}
            onChange={e => setOwner(e.target.value || null)}
            className="px-2 py-1 rounded-lg bg-surface border border-border text-xs text-gray-300"
          >
            <option value="">All</option>
            {owners.map(o => (
              <option key={o} value={o}>{demoText(o)}</option>
            ))}
          </select>
        )}
        {[1, 3, 6, 12].map(n => (
          <button
            key={n}
            onClick={() => setMonths(n)}
            className={`px-2 py-1 rounded text-xs transition-colors ${
              months === n ? 'bg-primary/15 text-primary' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {n}M
          </button>
        ))}
        <button
          onClick={() => setMonths('CUSTOM')}
          className={`px-2 py-1 rounded text-xs transition-colors ${
            months === 'CUSTOM' ? 'bg-primary/15 text-primary' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Custom
        </button>
      </div>

      {months === 'CUSTOM' && (
        <div className="mb-4">
          <DateRangePicker
            from={customFrom}
            to={customTo}
            onChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
          />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : tab === 'cashflow' ? (
        <>
          {/* Chart */}
          {cfChartData && (
            <div className="bg-surface rounded-xl border border-border p-5 mb-6">
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={cfChartData}>
                  <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => isDemoMode() ? '$••••' : `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    contentStyle={{ background: 'rgb(45 52 65)', border: '1px solid rgb(80 90 110)', borderRadius: 8, fontSize: 12, color: '#f1f5f9', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                  <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
                  <Bar dataKey="Income" fill="#34d399" radius={[3, 3, 0, 0]} barSize={24} />
                  <Bar dataKey="Expenses" fill="#f87171" radius={[3, 3, 0, 0]} barSize={24} />
                  <Line type="monotone" dataKey="Savings" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3, fill: '#60a5fa' }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Summary */}
          {cashflow && (
            <div className="bg-surface rounded-xl border border-border p-5 mb-6">
              <h3 className="text-sm font-medium text-white mb-4">Summary</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    <span className="text-sm text-slate-300">Total income</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-emerald-400">{formatCurrency(cashflow.totalIncome)}</span>
                </div>
                <div className="border-t border-border" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                    <span className="text-sm text-slate-300">Total expenses</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-red-400">{formatCurrency(cashflow.totalExpenses)}</span>
                </div>
                <div className="border-t border-border" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-400" />
                    <span className="text-sm text-slate-300">Savings</span>
                  </div>
                  <span className={`text-sm font-semibold tabular-nums ${cashflow.savings >= 0 ? 'text-white' : 'text-red-400'}`}>{formatCurrency(cashflow.savings)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Income categories */}
          {incomeCats.length > 0 && (
            <div className="bg-surface rounded-xl border border-border p-5 mb-6">
              <h3 className="text-sm font-medium text-white mb-3">Income</h3>
              <div className="space-y-1">
                {incomeCats.map((cat, i) => renderCategoryRow(cat, i, 'income'))}
              </div>
            </div>
          )}

          {/* Expense categories */}
          {expenseCats.length > 0 && (
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-medium text-white mb-3">Expenses</h3>
              <div className="space-y-1">
                {expenseCats.map((cat, i) => renderCategoryRow(cat, i, 'expense'))}
              </div>
            </div>
          )}
        </>
      ) : tab === 'sankey' ? (
        /* ─── Sankey Flow Tab ─── */
        <>
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-medium text-white mb-4">Money Flow</h3>
          {!sankeyData || !sankeyData.nodes.length ? (
            <p className="text-sm text-gray-500 text-center py-8">No flow data for this period.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <ResponsiveContainer width="100%" height={Math.max(400, sankeyData.nodes.length * 40)}>
                <Sankey
                  data={sankeyData}
                  nodeWidth={12}
                  nodePadding={24}
                  linkCurvature={0.5}
                  iterations={64}
                  margin={{ top: 20, right: 160, bottom: 20, left: 20 }}
                  link={({ sourceX, sourceY, sourceControlX, targetX, targetY, targetControlX, linkWidth, payload }: { sourceX: number; sourceY: number; sourceControlX: number; targetX: number; targetY: number; targetControlX: number; linkWidth: number; payload: { source: { name: string }; target: { name: string } } }) => {
                    const targetName = payload?.target?.name;
                    const sourceName = payload?.source?.name;
                    const linkColor = sankeyColorMap[targetName] || sankeyColorMap[sourceName] || '#334155';
                    return (
                      <path
                        d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
                        fill="none"
                        stroke={linkColor}
                        strokeWidth={linkWidth}
                        strokeOpacity={0.25}
                      />
                    );
                  }}
                  node={({ x, y, width, height, payload }: { x: number; y: number; width: number; height: number; index: number; payload: { name: string; value?: number } }) => {
                    const name = payload.name;
                    const isSavings = name === 'Savings';
                    const isSpending = name === 'Spending';
                    // Income sources feed into Spending/Savings, so they're not Spending/Savings/expense
                    const isHub = isSavings || isSpending;
                    // Expense nodes receive from Spending hub
                    const isExpense = !isHub && sankeyData.links.some(l => l.source === sankeyData.nodes.findIndex(n => n.name === 'Spending') && sankeyData.nodes[l.target]?.name === name);
                    const color = isSavings ? '#60a5fa' : isSpending ? '#f87171' : (sankeyColorMap[name] || (isExpense ? '#ef4444' : '#34d399'));

                    const cat = sankeyCategoryMap.get(name);
                    const clickable = !!cat;

                    const handleClick = () => {
                      if (cat) setSelectedCategory(prev => prev?.name === name ? null : { name, id: cat.id });
                    };

                    return (
                      <g onClick={handleClick} style={{ cursor: clickable ? 'pointer' : 'default' }}>
                        <rect x={x} y={y} width={width} height={height} fill={color} rx={3} />
                        <text
                          x={x + width + 8}
                          y={y + height / 2}
                          textAnchor="start"
                          dominantBaseline="central"
                          fill={clickable ? '#e2e8f0' : '#94a3b8'}
                          fontSize={11}
                        >
                          {payload.name}
                          {payload.value != null ? ` · ${isDemoMode() ? '$••••' : formatCurrency(payload.value)}` : ''}
                        </text>
                      </g>
                    );
                  }}
                >
                  <Tooltip
                    contentStyle={{ background: 'rgb(45 52 65)', border: '1px solid rgb(80 90 110)', borderRadius: 8, fontSize: 12, color: '#f1f5f9', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                    formatter={(value: number) => [formatCurrency(value)]}
                  />
                </Sankey>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Sankey category drill-down */}
        {selectedCategory && (
          <div className="bg-surface rounded-xl border border-border p-5 mt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-white flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: sankeyColorMap[selectedCategory.name] || (sankeyCategoryMap.get(selectedCategory.name)?.type === 'income' ? '#34d399' : '#f87171') }} />
                {selectedCategory.name}
                <span className="text-slate-500 font-normal">
                  {categoryTxns?.data ? `· ${categoryTxns.data.length} transactions` : ''}
                </span>
              </h3>
              <button
                onClick={() => setSelectedCategory(null)}
                className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
              >
                <ArrowLeft size={14} />
              </button>
            </div>

            {categoryTxns?.data && categoryTxns.data.length > 0 ? (
              <div className="divide-y divide-border">
                {categoryTxns.data
                  .filter(t => t.amount !== 0)
                  .map(txn => (
                  <div key={txn.id} onClick={() => setSelectedEntry(txn)} className="flex items-center justify-between py-2.5 cursor-pointer hover:bg-white/[0.02] transition-colors rounded px-1 -mx-1">
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{txn.merchant_name || txn.description}</div>
                      <div className="text-xs text-slate-600">
                        {new Date(String(txn.date)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </div>
                    </div>
                    <div className="text-sm tabular-nums text-slate-400 flex-shrink-0 ml-3">
                      {formatCurrency(Math.abs(txn.amount))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500 text-center py-4">No transactions</p>
            )}
          </div>
        )}
        </>
      ) : (
        /* ─── Spending / Income Tab ─── */
        <>
          <div className="bg-surface rounded-xl border border-border p-5">
            <h3 className="text-sm font-medium text-white mb-4">
              {tab === 'spending' ? 'Spending by Category' : 'Income by Source'}
            </h3>
            {!chartData ? (
              <p className="text-sm text-gray-500 text-center py-8">No {tab === 'income' ? 'income' : 'spending'} data for this period.</p>
            ) : (
              <div className="space-y-8">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={chartData.barData}>
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => isDemoMode() ? '$••••' : `$${(v/1000).toFixed(0)}k`} />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                      contentStyle={{ background: 'rgb(45 52 65)', border: '1px solid rgb(80 90 110)', borderRadius: 8, fontSize: 12, color: '#f1f5f9', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                      formatter={(value: number, name: string, props) => {
                        const raw = props?.payload?.[`_raw:${name}`];
                        if (raw !== undefined && raw < 0) return [`${formatCurrency(raw)} (net refund)`, name];
                        return [formatCurrency(value), name];
                      }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 11, color: '#94a3b8' }}
                      formatter={(value: string) => <span style={{ color: '#94a3b8' }}>{value}</span>}
                    />
                    {chartData.categories.map(cat => (
                      <Bar
                        key={cat}
                        dataKey={cat}
                        stackId="a"
                        fill={chartData.colorMap[cat] || '#64748b'}
                        cursor="pointer"
                        onClick={() => handleChartCategoryClick(cat)}
                        opacity={selectedCategory && selectedCategory.name !== cat ? 0.3 : 1}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>

                <div>
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Pie
                        data={chartData.pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={110}
                        paddingAngle={2}
                        dataKey="value"
                        cursor="pointer"
                        onClick={(_, index) => handleChartCategoryClick(chartData.pieData[index].name)}
                      >
                        {chartData.pieData.map((entry, i) => (
                          <Cell
                            key={entry.name}
                            fill={chartData.colorMap[entry.name] || CATEGORY_COLORS[i % CATEGORY_COLORS.length]}
                            opacity={selectedCategory && selectedCategory.name !== entry.name ? 0.3 : 1}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: 'rgb(45 52 65)', border: '1px solid rgb(80 90 110)', borderRadius: 8, fontSize: 12, color: '#f1f5f9', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                        formatter={(value: number, name: string) => [formatCurrency(value), name]}
                        itemStyle={{ color: 'inherit' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>

          {/* Chart category drill-down */}
          {selectedCategory && (
            <div className="bg-surface rounded-xl border border-border p-5 mt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: chartData?.colorMap[selectedCategory.name] }} />
                  {selectedCategory.name}
                  <span className="text-slate-500 font-normal">
                    {categoryTxns?.data ? `· ${categoryTxns.data.length} transactions` : ''}
                  </span>
                </h3>
                <button
                  onClick={() => setSelectedCategory(null)}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
                >
                  <ArrowLeft size={14} />
                </button>
              </div>

              {categoryTxns?.data && categoryTxns.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {categoryTxns.data
                    .filter(t => t.amount !== 0)
                    .map(txn => (
                    <div key={txn.id} onClick={() => setSelectedEntry(txn)} className="flex items-center justify-between py-2.5 cursor-pointer hover:bg-white/[0.02] transition-colors rounded px-1 -mx-1">
                      <div className="min-w-0">
                        <div className="text-sm text-white truncate">{txn.merchant_name || txn.description}</div>
                        <div className="text-xs text-slate-600">
                          {new Date(String(txn.date)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      </div>
                      <div className="text-sm tabular-nums text-slate-400 flex-shrink-0 ml-3">
                        {formatCurrency(Math.abs(txn.amount))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500 text-center py-4">No transactions</p>
              )}
            </div>
          )}
        </>
      )}

      {selectedEntry && (
        <TransactionDetail
          key={selectedEntry.id}
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}
