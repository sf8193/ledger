import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';
import { formatCurrency } from '../lib/spending';
import {
  Check, X, GitMerge, AlertCircle, ChevronRight, ChevronDown, Tag,
  ArrowRight,
} from 'lucide-react';

interface MatchSuggestion {
  id: string;
  match_type: string;
  confidence: number;
  entry_a_description: string;
  entry_a_date: string;
  entry_a_merchant: string | null;
  entry_b_description: string | null;
  entry_b_date: string | null;
  entry_b_merchant: string | null;
}

interface UncategorizedEntry {
  id: string;
  date: string;
  description: string;
  merchant_name: string | null;
  plaid_category: string | null;
  amount: number;
}

interface Category {
  id: string;
  name: string;
  account_type: string;
}

type ReviewItem =
  | { type: 'match'; data: MatchSuggestion }
  | { type: 'uncategorized'; data: UncategorizedEntry };

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCurrencyAbs(amount: number) {
  return formatCurrency(Math.abs(amount));
}

function stripRefs(value: string): string {
  return value
    .replace(/\s+(PPD|WEB|TEL|CCD)\s+ID:\s*\S+/gi, '')
    .replace(/\s+[A-Z0-9]{8,}$/i, '')
    .replace(/\s+PURCHASE\s+\d+/gi, '')
    .replace(/\*\S+$/, '')
    .trim();
}

export function ReviewBanner({ count, onReview }: { count: number; onReview: () => void }) {
  if (count === 0) return null;

  return (
    <button
      onClick={onReview}
      className="w-full flex items-center justify-between px-5 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors group"
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
          <AlertCircle size={16} className="text-amber-400" />
        </div>
        <div className="text-left">
          <span className="text-sm font-medium text-white">{count} item{count !== 1 ? 's' : ''} need{count === 1 ? 's' : ''} review</span>
          <span className="text-xs text-slate-500 ml-2">Transfers & uncategorized</span>
        </div>
      </div>
      <ChevronRight size={16} className="text-amber-400 group-hover:translate-x-0.5 transition-transform" />
    </button>
  );
}

export function ReviewCardStack({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [animating, setAnimating] = useState<'left' | 'right' | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [createRule, setCreateRule] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);

  const { data: suggestions } = useQuery<MatchSuggestion[]>({
    queryKey: ['match-suggestions'],
    queryFn: () => apiFetch('/matching/suggestions'),
  });

  const { data: uncategorizedData } = useQuery<{ data: UncategorizedEntry[]; total: number }>({
    queryKey: ['uncategorized'],
    queryFn: () => apiFetch('/matching/uncategorized'),
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  // Build unified review queue
  const items: ReviewItem[] = [
    ...(suggestions?.map(s => ({ type: 'match' as const, data: s })) || []),
    ...(uncategorizedData?.data?.map(u => ({ type: 'uncategorized' as const, data: u })) || []),
  ];

  const total = items.length;
  const current = items[currentIndex];
  const remaining = total - currentIndex;

  const advance = () => {
    setAnimating(null);
    setSelectedCategory('');
    setCreateRule(false);
    setReviewedCount(c => c + 1);
    if (currentIndex + 1 >= total) {
      // All done — show completion state
      queryClient.invalidateQueries({ queryKey: ['match-suggestions'] });
      queryClient.invalidateQueries({ queryKey: ['uncategorized'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setCompleted(true);
    } else {
      setCurrentIndex(i => i + 1);
    }
  };

  const handleAction = async (direction: 'left' | 'right') => {
    if (!current) return;
    setAnimating(direction);

    try {
      if (current.type === 'match') {
        if (direction === 'right') {
          await apiFetch(`/matching/suggestions/${current.data.id}/confirm`, { method: 'POST' });
          toast.success('Transfer confirmed');
        } else {
          await apiFetch(`/matching/suggestions/${current.data.id}/dismiss`, { method: 'POST' });
          toast.success('Dismissed');
        }
      } else if (current.type === 'uncategorized') {
        if (direction === 'right' && selectedCategory) {
          if (createRule) {
            const result = await apiFetch<{ rule: { match_value: string }; applied: number }>('/matching/rules/from-entry', {
              method: 'POST',
              body: JSON.stringify({
                entry_id: current.data.id,
                target_account_id: selectedCategory,
              }),
            });
            // Prune items that were auto-categorized by this rule
            if (result.applied > 0) {
              const pattern = result.rule.match_value.toLowerCase();
              const pruned = items.filter((item, idx) => {
                if (idx <= currentIndex) return true; // already processed
                if (item.type !== 'uncategorized') return true;
                const merchant = (item.data.merchant_name || item.data.description).toLowerCase();
                return !merchant.includes(pattern);
              });
              const removedCount = items.length - pruned.length;
              if (removedCount > 0) {
                toast.success(`Categorized + rule created · ${removedCount} similar auto-categorized`);
              } else {
                toast.success('Categorized + rule created');
              }
              // Note: items is derived from queries, so we invalidate to rebuild
              queryClient.invalidateQueries({ queryKey: ['uncategorized'] });
            } else {
              toast.success('Categorized + rule created');
            }
          } else {
            await apiFetch(`/transactions/${current.data.id}`, {
              method: 'PUT',
              body: JSON.stringify({ category_id: selectedCategory }),
            });
            toast.success('Categorized');
          }
        } else {
          // Skip
        }
      }
      setTimeout(advance, 300);
    } catch (err) {
      toast.error((err as Error).message || 'Action failed');
      setAnimating(null);
    }
  };

  if (completed || !current) {
    return (
      <div className="card p-8 text-center animate-fade-in">
        <div className="w-12 h-12 rounded-full bg-emerald-400/15 flex items-center justify-center mx-auto mb-4">
          <Check size={24} className="text-emerald-400" />
        </div>
        <p className="text-lg font-medium text-white">All caught up</p>
        {reviewedCount > 0 ? (
          <p className="text-sm text-slate-500 mt-1">{reviewedCount} item{reviewedCount !== 1 ? 's' : ''} reviewed</p>
        ) : (
          <p className="text-sm text-slate-500 mt-1">Nothing to review right now</p>
        )}
        <button
          onClick={onClose}
          className="mt-5 px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm hover:bg-primary/20 transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Progress */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{currentIndex + 1} of {total}</span>
        <span className="text-xs text-slate-500">{remaining} remaining</span>
      </div>
      <div className="w-full bg-surface-lighter rounded-full h-1">
        <div
          className="bg-primary h-1 rounded-full transition-all duration-300"
          style={{ width: `${((currentIndex + 1) / total) * 100}%` }}
        />
      </div>

      {/* Card */}
      <div
        className={`card p-6 transition-all duration-300 ${
          animating === 'left' ? 'opacity-0 -translate-x-8' :
          animating === 'right' ? 'opacity-0 translate-x-8' : ''
        }`}
      >
        {current.type === 'match' ? (
          <MatchCard item={current.data} />
        ) : (
          <UncategorizedCard
            item={current.data}
            categories={categories || []}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            createRule={createRule}
            onToggleRule={setCreateRule}
          />
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={() => handleAction('left')}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-surface border border-border text-slate-400 hover:text-red-400 hover:border-red-400/30 transition-all"
        >
          <X size={18} />
          {current.type === 'match' ? 'Not a match' : 'Skip'}
        </button>
        <button
          onClick={() => handleAction('right')}
          disabled={current.type === 'uncategorized' && !selectedCategory}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Check size={18} />
          {current.type === 'match' ? 'Confirm transfer' : 'Categorize'}
        </button>
      </div>

      <button
        onClick={onClose}
        className="w-full text-center text-xs text-slate-600 hover:text-slate-400 transition-colors py-2"
      >
        Finish later
      </button>
    </div>
  );
}

function MatchCard({ item }: { item: MatchSuggestion }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <GitMerge size={14} className="text-accent" />
        <span>Transfer match</span>
        <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">
          {Math.round(item.confidence * 100)}%
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1 card-inset p-4">
          <div className="text-sm font-medium text-white">{item.entry_a_merchant || item.entry_a_description}</div>
          <div className="text-xs text-slate-500 mt-1">{formatDate(item.entry_a_date)}</div>
        </div>

        <ArrowRight size={16} className="text-slate-600 flex-shrink-0" />

        <div className="flex-1 card-inset p-4">
          <div className="text-sm font-medium text-white">{item.entry_b_merchant || item.entry_b_description || '—'}</div>
          <div className="text-xs text-slate-500 mt-1">{item.entry_b_date ? formatDate(item.entry_b_date) : ''}</div>
        </div>
      </div>

      <p className="text-xs text-slate-500 text-center">Are these the same transaction between two accounts?</p>
    </div>
  );
}

function UncategorizedCard({
  item, categories, selectedCategory, onSelectCategory, createRule, onToggleRule,
}: {
  item: UncategorizedEntry;
  categories: Category[];
  selectedCategory: string;
  onSelectCategory: (id: string) => void;
  createRule: boolean;
  onToggleRule: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);
  const isExpense = item.amount > 0;
  const relevantCategories = categories.filter(c =>
    isExpense ? c.account_type === 'expense' : c.account_type === 'income'
  );
  const filtered = search
    ? relevantCategories.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    : relevantCategories;

  const selectedName = relevantCategories.find(c => c.id === selectedCategory)?.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Tag size={14} className="text-amber-400" />
        <span>Needs category</span>
      </div>

      <div className="card-inset p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">{item.merchant_name || item.description}</div>
            <div className="text-xs text-slate-500 mt-1">
              {formatDate(item.date)}
              {item.plaid_category && <span className="ml-2 text-slate-600">({item.plaid_category})</span>}
            </div>
          </div>
          <div className={`text-lg font-medium tabular-nums ${isExpense ? 'text-red-400' : 'text-emerald-400'}`}>
            {isExpense ? '-' : '+'}{formatCurrencyAbs(item.amount)}
          </div>
        </div>
      </div>

      {/* Category dropdown with search */}
      <div className="relative" ref={dropdownRef}>
        <label className="block text-xs text-slate-500 mb-1.5">Assign to category</label>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${
            selectedCategory
              ? 'bg-primary/10 border border-primary/30 text-primary'
              : 'bg-surface-lighter border border-border text-slate-400 hover:text-white'
          }`}
        >
          <span>{selectedName || 'Select a category...'}</span>
          <ChevronDown size={14} className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>

        {dropdownOpen && (
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in">
            <div className="p-2 border-b border-border">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search categories..."
                className="w-full px-2.5 py-1.5 rounded bg-background border border-border text-white text-xs placeholder-slate-600"
                autoFocus
              />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filtered.length > 0 ? filtered.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => {
                    onSelectCategory(cat.id);
                    setDropdownOpen(false);
                    setSearch('');
                  }}
                  className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                    selectedCategory === cat.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  {cat.name}
                </button>
              )) : (
                <div className="px-3 py-3 text-xs text-slate-500 text-center">No categories match</div>
              )}
            </div>
            <button
              onClick={async () => {
                const name = search.trim() || prompt('Category name:');
                if (!name) return;
                try {
                  const result = await apiFetch<{ id: string }>('/categories', {
                    method: 'POST',
                    body: JSON.stringify({ name, is_income: !isExpense }),
                  });
                  queryClient.invalidateQueries({ queryKey: ['categories'] });
                  onSelectCategory(result.id);
                  setDropdownOpen(false);
                  setSearch('');
                  toast.success(`Created "${name}"`);
                } catch {
                  toast.error('Failed to create category');
                }
              }}
              className="w-full px-3 py-2 text-left text-sm text-emerald-400 hover:bg-emerald-400/10 transition-colors border-t border-border"
            >
              + New category{search.trim() ? ` "${search.trim()}"` : ''}
            </button>
          </div>
        )}
      </div>

      {selectedCategory && (
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer animate-fade-in">
          <input
            type="checkbox"
            checked={createRule}
            onChange={(e) => onToggleRule(e.target.checked)}
            className="rounded"
          />
          Always categorize "{item.merchant_name || stripRefs(item.description)}" this way
        </label>
      )}
    </div>
  );
}
