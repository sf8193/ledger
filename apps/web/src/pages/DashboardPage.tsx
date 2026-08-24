import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Link } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, Wallet,
  ReceiptText,
} from 'lucide-react';
import { ReviewBanner, ReviewCardStack } from '../components/ReviewCardStack';
import { PlaidLinkButton } from '../components/PlaidLink';
import { QueryError } from '../components/QueryState';
import { CATEGORY_COLORS, formatCurrency, transformSpendingData } from '../lib/spending';
import { isDemoMode, demoText } from '../hooks/useDemo';
import type { SpendingBreakdown } from '../lib/spending';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

interface DashboardData {
  netWorth: number;
  accountCount: number;
  monthlySpending: number;
  monthlyIncome: number;
  pendingReimbursements: number;
  recentEntries: Array<{
    id: string;
    description: string;
    merchant_name: string | null;
    date: string;
    owner: string | null;
    amount: number | null;
    source: string | null;
  }>;
}

interface NlvHistory {
  history: Array<{ date: string; netWorth: number }>;
}

interface MatchSuggestion {
  id: string;
}

interface UncategorizedData {
  data: Array<{ id: string }>;
  total: number;
}

function formatCompact(amount: number): string {
  if (isDemoMode()) return '$••••';
  if (Math.abs(amount) >= 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      notation: 'compact', maximumFractionDigits: 1,
    }).format(amount);
  }
  return formatCurrency(amount);
}

export function DashboardPage() {
  const queryClient = useQueryClient();
  const [showReview, setShowReview] = useState(false);
  const [nlvRange, setNlvRange] = useState<'1M' | '3M' | '6M' | '1Y' | 'ALL' | 'CUSTOM'>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [spendingMonths, setSpendingMonths] = useState<number | 'CUSTOM'>(6);
  const [spendingOwner, setSpendingOwner] = useState<string | null>(null);
  const [spendingView, setSpendingView] = useState<'bar' | 'pie'>('bar');
  const [spendingFrom, setSpendingFrom] = useState('');
  const [spendingTo, setSpendingTo] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => apiFetch('/dashboard'),
  });

  const { data: suggestions } = useQuery<MatchSuggestion[]>({
    queryKey: ['match-suggestions'],
    queryFn: () => apiFetch('/matching/suggestions'),
  });

  const { data: uncategorizedData } = useQuery<UncategorizedData>({
    queryKey: ['uncategorized'],
    queryFn: () => apiFetch('/matching/uncategorized'),
  });

  const { data: nlvData } = useQuery<NlvHistory>({
    queryKey: ['nlv-history'],
    queryFn: () => apiFetch('/dashboard/nlv-history'),
    staleTime: 5 * 60 * 1000,
  });

  const { data: spendingData } = useQuery<SpendingBreakdown>({
    queryKey: ['spending-breakdown', spendingMonths, spendingOwner, spendingFrom, spendingTo],
    queryFn: () => {
      const params = new URLSearchParams();
      if (spendingMonths === 'CUSTOM') {
        if (spendingFrom) params.set('from', spendingFrom);
        if (spendingTo) params.set('to', spendingTo);
      } else {
        params.set('months', String(spendingMonths));
      }
      if (spendingOwner) params.set('owner', spendingOwner);
      return apiFetch(`/dashboard/spending-breakdown?${params}`);
    },
    staleTime: 5 * 60 * 1000,
  });

  const reviewCount = (suggestions?.length || 0) + (uncategorizedData?.total || 0);

  // Spending breakdown chart data (memoized) — must be before early returns to keep hook order stable
  const spendingChartData = useMemo(() => spendingData ? transformSpendingData(spendingData) : null, [spendingData]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 card p-6 h-32 animate-pulse" />
          <div className="card p-6 h-32 animate-pulse" />
        </div>
        <div className="card h-64 animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Overview</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load dashboard'} onRetry={() => refetch()} />
      </div>
    );
  }

  const netWorth = data?.netWorth || 0;
  const spending = data?.monthlySpending || 0;
  const income = data?.monthlyIncome || 0;
  const savingsRate = income > 0 ? Math.round(((income - spending) / income) * 100) : 0;
  const spendingRatio = income > 0 ? Math.min((spending / income) * 100, 100) : 0;

  // Review mode
  if (showReview) {
    return (
      <div className="max-w-lg mx-auto py-8">
        <ReviewCardStack onClose={() => setShowReview(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Overview</h1>
        <p className="text-sm text-slate-500 mt-1">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* Review banner */}
      <ReviewBanner count={reviewCount} onReview={() => setShowReview(true)} />

      {/* This Month — income & spending */}
      <div className="card p-6">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">This Month</span>

        <div className="mt-3 space-y-3">
          {/* Income */}
          <Link to="/reports?tab=income&months=1" className="flex items-center justify-between group">
            <span className="text-xs text-slate-400">Income</span>
            <span className="text-sm font-medium text-emerald-400 tabular-nums group-hover:underline">{formatCompact(income)}</span>
          </Link>

          {/* Spending */}
          <Link to="/reports?tab=spending&months=1" className="flex items-center justify-between group">
            <span className="text-xs text-slate-400">Spending</span>
            <span className="text-sm font-medium text-red-400 tabular-nums group-hover:underline">{formatCompact(spending)}</span>
          </Link>

          {/* Ratio bar */}
          <div>
            <div className="w-full h-1.5 bg-surface-lighter rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isDemoMode() ? 'bg-emerald-400' :
                  spendingRatio > 90 ? 'bg-red-400' : spendingRatio > 70 ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
                style={{ width: isDemoMode() ? '50%' : `${spendingRatio}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-slate-600">
                {!isDemoMode() && spendingRatio > 0 ? `${Math.round(spendingRatio)}% spent` : ''}
              </span>
              {!isDemoMode() && savingsRate > 0 && (
                <span className="text-[10px] text-emerald-400/60">{savingsRate}% saved</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Net worth + chart */}
      {(() => {
        let chartData: Array<{ date: string; netWorth: number }> | null = null;
        if (nlvData?.history && nlvData.history.length > 1) {
          const rangeMonths = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, 'ALL': 0, 'CUSTOM': 0 } as const;
          chartData = nlvData.history;
          if (nlvRange === 'CUSTOM') {
            chartData = chartData.filter(d =>
              (!customFrom || d.date >= customFrom) && (!customTo || d.date <= customTo)
            );
          } else {
            const months = rangeMonths[nlvRange];
            if (months > 0) {
              const cutoff = new Date(new Date().setMonth(new Date().getMonth() - months)).toISOString().slice(0, 10);
              chartData = chartData.filter(d => d.date >= cutoff);
            }
          }
          if (chartData.length < 2) chartData = null;
        }

        return (
          <div className="card p-6">
            {/* Net worth header */}
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Net Worth</span>
                  {netWorth !== 0 && (
                    <span className={`flex items-center gap-0.5 text-xs ${netWorth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {netWorth >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    </span>
                  )}
                </div>
                <div className={`text-3xl font-semibold tabular-nums tracking-tight ${netWorth >= 0 ? 'text-white' : 'text-red-400'}`}>
                  {formatCurrency(netWorth)}
                </div>
                <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                  <span>{data?.accountCount || 0} account{(data?.accountCount || 0) !== 1 ? 's' : ''}</span>
                  {(data?.pendingReimbursements || 0) > 0 && (
                    <Link to="/reimbursements" className="text-amber-400 hover:text-amber-300 transition-colors">
                      {formatCompact(data!.pendingReimbursements)} pending reimbursement
                    </Link>
                  )}
                </div>
              </div>

              {/* Range selector */}
              {chartData && (
                <div className="flex items-center gap-1 flex-wrap">
                  {(['1M', '3M', '6M', '1Y', 'ALL', 'CUSTOM'] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setNlvRange(r)}
                      className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                        nlvRange === r
                          ? 'bg-primary/20 text-primary'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {r === 'CUSTOM' ? 'Custom' : r}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {nlvRange === 'CUSTOM' && chartData && (
              <div className="flex items-center gap-1 mb-4">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-slate-300 [color-scheme:dark] flex-1 min-w-0"
                />
                <span className="text-[11px] text-slate-600">–</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-slate-300 [color-scheme:dark] flex-1 min-w-0"
                />
              </div>
            )}

            {/* Chart */}
            {chartData && (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="nlvGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#64748b', fontSize: 11 }}
                      tickFormatter={(d) => new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
                      minTickGap={60}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#64748b', fontSize: 11 }}
                      tickFormatter={(v) => formatCompact(v)}
                      width={50}
                      domain={['dataMin', 'dataMax']}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                      labelStyle={{ color: '#94a3b8', fontSize: 12 }}
                      labelFormatter={(d) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      formatter={(value: number | string) => [formatCurrency(Number(value)), 'Net Worth']}
                    />
                    <Area
                      type="monotone"
                      dataKey="netWorth"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#nlvGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}

      {/* Spending Breakdown */}
      {spendingChartData && (() => {
        const { barData, pieData, categories, colorMap } = spendingChartData;

        return (
          <div className="card p-6">
            <div className="mb-4 space-y-2.5">
              <h2 className="text-sm font-medium text-white">Spending Breakdown</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Owner filter */}
                <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
                  <button
                    onClick={() => setSpendingOwner(null)}
                    className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                      !spendingOwner ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    All
                  </button>
                  {spendingData?.owners.map(o => (
                    <button
                      key={o}
                      onClick={() => setSpendingOwner(spendingOwner === o ? null : o)}
                      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                        spendingOwner === o ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
                {/* Month range */}
                <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
                  {([3, 6, 12] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setSpendingMonths(m)}
                      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                        spendingMonths === m ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {m}M
                    </button>
                  ))}
                  <button
                    onClick={() => setSpendingMonths('CUSTOM')}
                    className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                      spendingMonths === 'CUSTOM' ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {/* View toggle */}
                <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
                  {(['bar', 'pie'] as const).map(v => (
                    <button
                      key={v}
                      onClick={() => setSpendingView(v)}
                      className={`px-2.5 py-1 text-[11px] rounded transition-colors capitalize ${
                        spendingView === v ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {spendingMonths === 'CUSTOM' && (
              <div className="flex items-center gap-1 mb-4">
                <input
                  type="date"
                  value={spendingFrom}
                  onChange={(e) => setSpendingFrom(e.target.value)}
                  className="bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-slate-300 [color-scheme:dark] flex-1 min-w-0"
                />
                <span className="text-[11px] text-slate-600">–</span>
                <input
                  type="date"
                  value={spendingTo}
                  onChange={(e) => setSpendingTo(e.target.value)}
                  className="bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-slate-300 [color-scheme:dark] flex-1 min-w-0"
                />
              </div>
            )}

            {spendingView === 'bar' ? (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#64748b', fontSize: 11 }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#64748b', fontSize: 11 }}
                      tickFormatter={formatCompact}
                      width={50}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                      labelStyle={{ color: '#94a3b8', fontSize: 12 }}
                      formatter={(value: number | string, name: string, props: { payload?: Record<string, number> }) => {
                        const raw = props.payload?.[`_raw:${name}`];
                        if (raw !== undefined) return [`${formatCurrency(raw)} (net refund)`, name];
                        return [formatCurrency(Number(value)), name];
                      }}
                    />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: 11, color: '#94a3b8', paddingTop: 8 }}
                    />
                    {categories.map((c: string) => (
                      <Bar
                        key={c}
                        dataKey={c}
                        stackId="spending"
                        fill={colorMap[c]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="35%"
                      cy="50%"
                      outerRadius={110}
                      innerRadius={55}
                      paddingAngle={2}
                      stroke="none"
                    >
                      {pieData.map((d: { name: string; value: number }, i: number) => (
                        <Cell key={d.name} fill={colorMap[d.name] || CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                      formatter={(value: number | string) => [formatCurrency(Number(value))]}
                    />
                    <Legend
                      layout="vertical"
                      align="right"
                      verticalAlign="middle"
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: 11, color: '#94a3b8', paddingLeft: 16 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}

      {/* Recent activity */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-medium text-white">Recent Activity</h2>
          <Link to="/transactions" className="text-xs text-primary hover:text-primary/80 transition-colors">
            View all
          </Link>
        </div>
        {data?.recentEntries?.length ? (
          <div className="divide-y divide-border">
            {data.recentEntries
              .filter((e) => !e.description.startsWith('Opening balance:'))
              .map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-surface-lighter flex items-center justify-center flex-shrink-0">
                    <ReceiptText size={14} className="text-slate-500" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">
                      {entry.merchant_name || entry.description}
                    </div>
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <span>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      {entry.owner && (
                        <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px]">
                          {demoText(entry.owner)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {entry.amount != null && (
                  <span className={`text-sm font-medium tabular-nums flex-shrink-0 ${
                    entry.amount > 0 ? 'text-red-400' : 'text-emerald-400'
                  }`}>
                    {entry.amount > 0 ? '-' : '+'}{formatCurrency(Math.abs(entry.amount))}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10">
            <div className="text-center mb-6">
              <Wallet size={32} className="text-slate-700 mx-auto mb-3" />
              <p className="text-sm text-white font-medium">Welcome to Ledger</p>
              <p className="text-xs text-slate-500 mt-1">Connect your bank to start tracking your finances</p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <PlaidLinkButton onSuccess={() => {
                queryClient.invalidateQueries();
              }} />
              <Link to="/import" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                or import from Monarch
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
