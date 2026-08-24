import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { ArrowLeftRight, Search, Clock, User, Plus, SlidersHorizontal, Tag } from 'lucide-react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { QueryError, ListSkeleton } from '../components/QueryState';
import { TransactionDetail } from '../components/TransactionDetail';
import { ManualEntryForm } from '../components/ManualEntryForm';
import { DateRangePicker } from '../components/DateRangePicker';
import { formatCurrency } from '../lib/spending';
import { demoText } from '../hooks/useDemo';

interface JournalLine {
  id: string;
  journal_entry_id: string;
  account_id: string;
  amount: number;
  account_name: string;
  account_type: string;
}

interface JournalEntry {
  id: string;
  description: string;
  merchant_name: string | null;
  date: string;
  owner: string | null;
  notes: string | null;
  is_verified: boolean;
  source: string | null;
  exclude_from_totals?: boolean | null;
  reimbursement_status?: 'pending' | 'reimbursed' | null;
  categorized_by?: string | null;
  lines: JournalLine[];
  amount: number;
  category?: JournalLine;
  transfer?: { from_account: string; to_account: string; amount: number };
  tags?: Array<{ id: string; name: string }>;
}

interface PendingTransaction {
  id: string;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  account_name: string;
  pending: true;
}

interface TransactionsResponse {
  data: JournalEntry[];
  pending: PendingTransaction[];
  total: number;
}

interface Account {
  id: string;
  name: string;
  account_type: string;
  institution_name: string | null;
}

interface Category {
  id: string;
  name: string;
  account_type: string;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateFull(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function groupByDate(entries: JournalEntry[]): { date: string; entries: JournalEntry[]; total: number }[] {
  const groups = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    const date = String(entry.date).slice(0, 10);
    const group = groups.get(date) || [];
    group.push(entry);
    groups.set(date, group);
  }
  return Array.from(groups.entries()).map(([date, entries]) => ({
    date,
    entries,
    total: entries.reduce((sum, e) => {
      if (e.transfer) return sum;
      return sum + e.amount;
    }, 0),
  }));
}

const ownerColorClasses = [
  'bg-blue-500/15 text-blue-400',
  'bg-purple-500/15 text-purple-400',
  'bg-emerald-500/15 text-emerald-400',
  'bg-amber-500/15 text-amber-400',
  'bg-cyan-500/15 text-cyan-400',
];

type DatePreset = 'this_month' | 'last_month' | 'last_90' | 'this_year' | 'all' | 'custom';
type TxnType = 'all' | 'expenses' | 'income' | 'transfers';

function getDateRange(preset: DatePreset): { start_date?: string; end_date?: string } {
  const now = new Date();
  switch (preset) {
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start_date: start.toISOString().slice(0, 10) };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
    }
    case 'last_90': {
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      return { start_date: start.toISOString().slice(0, 10) };
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { start_date: start.toISOString().slice(0, 10) };
    }
    case 'all':
    case 'custom':
      return {};
  }
}

const datePresetLabels: Record<Exclude<DatePreset, 'custom'>, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_90: 'Last 90 days',
  this_year: 'This year',
  all: 'All time',
};

const datePresetLabelsMobile: Record<Exclude<DatePreset, 'custom'>, string> = {
  this_month: 'Month',
  last_month: 'Last mo',
  last_90: '90d',
  this_year: 'YTD',
  all: 'All',
};

const PAGE_SIZE = 100;

export function TransactionsPage() {
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [showNewEntry, setShowNewEntry] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [extraEntries, setExtraEntries] = useState<JournalEntry[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset>('this_month');
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [txnType, setTxnType] = useState<TxnType>('all');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

  const { data: accounts } = useQuery<Account[]>({
    queryKey: ['filter-accounts'],
    queryFn: () => apiFetch('/accounts'),
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  const { data: allTags } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['tags'],
    queryFn: () => apiFetch('/transactions/tags'),
  });

  // Build dynamic owner color map from API data
  const ownerColors = useMemo(() => {
    const map: Record<string, string> = {};
    (owners || []).forEach((o, i) => {
      map[o] = ownerColorClasses[i % ownerColorClasses.length];
    });
    return map;
  }, [owners]);

  const bankAccounts = useMemo(() =>
    (accounts || []).filter(a => a.account_type === 'asset' || a.account_type === 'liability'),
    [accounts]
  );

  const categoryAccounts = useMemo(() =>
    (categories || []).filter(c => c.name !== 'Uncategorized' && c.name !== 'Uncategorized Income'),
    [categories]
  );

  const buildQueryParams = useCallback((pageOffset: number) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(pageOffset));
    if (ownerFilter) params.set('owner', ownerFilter);
    if (debouncedSearch) params.set('search', debouncedSearch);
    for (const id of accountIds) params.append('account_id', id);
    for (const id of categoryIds) params.append('category_id', id);
    for (const id of tagIds) params.append('tag_id', id);
    if (txnType !== 'all') params.set('type', txnType);
    if (minAmount) params.set('min_amount', minAmount);
    if (maxAmount) params.set('max_amount', maxAmount);
    if (datePreset === 'custom') {
      if (customDateFrom) params.set('start_date', customDateFrom);
      if (customDateTo) params.set('end_date', customDateTo);
    } else {
      const dateRange = getDateRange(datePreset);
      if (dateRange.start_date) params.set('start_date', dateRange.start_date);
      if (dateRange.end_date) params.set('end_date', dateRange.end_date);
    }
    return params.toString();
  }, [ownerFilter, debouncedSearch, accountIds, categoryIds, tagIds, txnType, minAmount, maxAmount, datePreset, customDateFrom, customDateTo]);

  const { data: response, isLoading, isFetching, isError, error, refetch } = useQuery<TransactionsResponse>({
    queryKey: ['transactions', ownerFilter, debouncedSearch, accountIds, categoryIds, tagIds, txnType, minAmount, maxAmount, datePreset, customDateFrom, customDateTo],
    queryFn: () => apiFetch(`/transactions?${buildQueryParams(0)}`),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  // Reset accumulated entries when filters change
  useEffect(() => {
    setExtraEntries([]);
  }, [ownerFilter, debouncedSearch, accountIds, categoryIds, tagIds, txnType, minAmount, maxAmount, datePreset, customDateFrom, customDateTo]);

  const entries = useMemo(() => {
    if (!response) return [];
    return [...response.data, ...extraEntries].filter(e => e.amount !== 0 || e.transfer);
  }, [response, extraEntries]);

  const loadMore = useCallback(async () => {
    setIsLoadingMore(true);
    try {
      const nextOffset = (response?.data.length || 0) + extraEntries.length;
      const res: TransactionsResponse = await apiFetch(`/transactions?${buildQueryParams(nextOffset)}`);
      setExtraEntries(prev => [...prev, ...res.data]);
    } finally {
      setIsLoadingMore(false);
    }
  }, [buildQueryParams, response, extraEntries.length]);

  const pending = response?.pending || [];
  const total = response?.total || 0;

  const activeFilterCount = [
    accountIds.length > 0,
    categoryIds.length > 0,
    tagIds.length > 0,
    minAmount,
    maxAmount,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setDatePreset('this_month');
    setCustomDateFrom('');
    setCustomDateTo('');
    setAccountIds([]);
    setCategoryIds([]);
    setTxnType('all');
    setMinAmount('');
    setMaxAmount('');
    setTagIds([]);
    setOwnerFilter(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Activity</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load transactions'} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-white">Activity</h1>
          <button
            onClick={() => setShowNewEntry(true)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
            title="New entry"
          >
            <Plus size={16} />
          </button>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          {entries.length} of {total} entries
          {pending.length > 0 && ` · ${pending.length} pending`}
        </p>
      </div>

      {/* Search + filter toggle */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-10 py-2 rounded-lg bg-surface border border-border text-white text-sm"
          />
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
              showFilters || activeFilterCount > 0 ? 'text-primary' : 'text-slate-500 hover:text-white'
            }`}
          >
            <SlidersHorizontal size={14} />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-primary text-[8px] text-white flex items-center justify-center font-medium">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {owners && owners.length > 0 && (
          <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
            <button
              onClick={() => setOwnerFilter(null)}
              className={`px-2.5 py-1.5 rounded text-xs transition-colors ${
                !ownerFilter ? 'bg-primary/15 text-primary' : 'text-slate-500 hover:text-white'
              }`}
            >
              All
            </button>
            {owners.map((o) => (
              <button
                key={o}
                onClick={() => setOwnerFilter(ownerFilter === o ? null : o)}
                className={`px-2.5 py-1.5 rounded text-xs transition-colors ${
                  ownerFilter === o ? 'bg-primary/15 text-primary' : 'text-slate-500 hover:text-white'
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Date presets + type pills */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
          {(Object.keys(datePresetLabels) as Exclude<DatePreset, 'custom'>[]).map((key) => (
            <button
              key={key}
              onClick={() => setDatePreset(key)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                datePreset === key ? 'bg-primary/15 text-primary' : 'text-slate-500 hover:text-white'
              }`}
            >
              <span className="hidden sm:inline">{datePresetLabels[key]}</span>
              <span className="sm:hidden">{datePresetLabelsMobile[key]}</span>
            </button>
          ))}
          <DateRangePicker
            from={datePreset === 'custom' ? customDateFrom : ''}
            to={datePreset === 'custom' ? customDateTo : ''}
            onChange={(from, to) => {
              if (from) {
                setDatePreset('custom');
                setCustomDateFrom(from);
                setCustomDateTo(to);
              }
            }}
          />
        </div>
        <div className="flex items-center bg-white/[0.04] rounded-md p-0.5">
          {(['all', 'expenses', 'income', 'transfers'] as TxnType[]).map((t) => (
            <button
              key={t}
              onClick={() => setTxnType(t)}
              className={`px-2.5 py-1 rounded text-xs capitalize transition-colors ${
                txnType === t ? 'bg-primary/15 text-primary' : 'text-slate-500 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Expanded filters */}
      {showFilters && (
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[10px] text-slate-600 mb-1.5 uppercase tracking-wider">Accounts</label>
            <div className="flex flex-wrap gap-1">
              {bankAccounts.map((a) => {
                const active = accountIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => setAccountIds(active ? accountIds.filter(id => id !== a.id) : [...accountIds, a.id])}
                    className={`px-2 py-1 rounded text-[11px] transition-colors ${
                      active ? 'bg-primary/15 text-primary' : 'bg-surface border border-border text-slate-500 hover:text-white'
                    }`}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[10px] text-slate-600 mb-1.5 uppercase tracking-wider">Categories</label>
            <div className="flex flex-wrap gap-1">
              {categoryAccounts.map((c) => {
                const active = categoryIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => setCategoryIds(active ? categoryIds.filter(id => id !== c.id) : [...categoryIds, c.id])}
                    className={`px-2 py-1 rounded text-[11px] transition-colors ${
                      active ? 'bg-primary/15 text-primary' : 'bg-surface border border-border text-slate-500 hover:text-white'
                    }`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>

          {allTags && allTags.length > 0 && (
            <div>
              <label className="block text-[10px] text-slate-600 mb-1.5 uppercase tracking-wider">Tags</label>
              <div className="flex flex-wrap gap-1">
                {allTags.map((t) => {
                  const active = tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTagIds(active ? tagIds.filter(id => id !== t.id) : [...tagIds, t.id])}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                        active ? 'bg-primary/15 text-primary' : 'bg-surface border border-border text-slate-500 hover:text-white'
                      }`}
                    >
                      <Tag size={10} />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="w-24">
            <label className="block text-[10px] text-slate-600 mb-1 uppercase tracking-wider">Min $</label>
            <input
              type="number"
              placeholder="0"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-white text-xs"
            />
          </div>

          <div className="w-24">
            <label className="block text-[10px] text-slate-600 mb-1 uppercase tracking-wider">Max $</label>
            <input
              type="number"
              placeholder="∞"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-white text-xs"
            />
          </div>

          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs text-slate-500 hover:text-white transition-colors pb-1.5">
              Clear
            </button>
          )}
        </div>
      )}

      {/* Pending transactions — hidden when type/category filters are active since pending items lack categories */}
      {pending.length > 0 && txnType === 'all' && categoryIds.length === 0 && (
        <div>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Clock size={12} />
            Pending ({pending.length})
          </h2>
          <div className="card divide-y divide-border">
            {pending.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between px-4 py-3 opacity-60">
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{tx.merchant_name || tx.description}</div>
                  <div className="text-xs text-slate-500">{formatDate(tx.date)} · {tx.account_name}</div>
                </div>
                <div className={`text-sm tabular-nums ${tx.amount > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                  {tx.amount > 0 ? '+' : ''}{formatCurrency(Math.abs(tx.amount))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Journal entries grouped by date */}
      <div className={`transition-opacity duration-150 ${isFetching ? 'opacity-60' : ''}`}>
      {entries.length > 0 ? (
        <>
          {groupByDate(entries).map((group) => (
            <div key={group.date}>
              {/* Date header */}
              <div className="flex items-center justify-between px-1 py-2">
                <span className="text-xs font-medium text-slate-500">{formatDateFull(group.date)}</span>
                {group.total !== 0 && (
                  <span className="text-xs tabular-nums text-slate-500">
                    {formatCurrency(Math.abs(group.total))}
                  </span>
                )}
              </div>

              <div className="card divide-y divide-border">
                {group.entries.map((entry) => (
                  <div key={entry.id} onClick={() => setSelectedEntry(entry)} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer">
                    <div className="flex items-center gap-3 min-w-0">
                      {entry.transfer && (
                        <ArrowLeftRight size={14} className="text-slate-600 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className={`text-sm truncate flex items-center gap-2 ${entry.transfer ? 'text-slate-400' : 'text-white'}`}>
                          {entry.transfer
                            ? `${entry.transfer.from_account} → ${entry.transfer.to_account}`
                            : (entry.merchant_name || entry.description)}
                          {entry.owner && (
                            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] ${ownerColors[entry.owner] || 'bg-slate-500/15 text-slate-400'}`}>
                              <User size={9} />
                              {demoText(entry.owner)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {!entry.transfer && entry.category && (
                            <span className="text-xs text-slate-600">{entry.category.account_name}</span>
                          )}
                          {entry.transfer && (
                            <span className="text-xs text-slate-600">Transfer</span>
                          )}
                          {entry.tags && entry.tags.length > 0 && entry.tags.map(t => (
                            <span key={t.id} className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] bg-slate-500/10 text-slate-500">
                              <Tag size={8} />
                              {t.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className={`text-sm font-medium tabular-nums flex-shrink-0 ${
                      entry.transfer ? 'text-slate-500' : entry.amount > 0 ? 'text-red-400' : entry.amount < 0 ? 'text-emerald-400' : 'text-slate-500'
                    }`}>
                      {entry.transfer
                        ? formatCurrency(entry.transfer.amount)
                        : <>{entry.amount > 0 ? '' : '+'}{formatCurrency(Math.abs(entry.amount))}</>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Load more */}
          {entries.length < total && (
            <div className="text-center py-3">
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="px-4 py-2 rounded-lg bg-surface border border-border text-xs text-slate-400 hover:text-white hover:border-slate-500 transition-colors disabled:opacity-50"
              >
                {isLoadingMore ? 'Loading...' : `Load more (${entries.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="card px-5 py-12 text-center">
          <ArrowLeftRight size={28} className="text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-white">No transactions found</p>
          <p className="text-xs text-slate-500 mt-1">
            {search || activeFilterCount > 0 ? 'Try adjusting your filters' : 'Connect a bank or import transactions'}
          </p>
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

      {showNewEntry && (
        <ManualEntryForm onClose={() => setShowNewEntry(false)} />
      )}
    </div>
  );
}
