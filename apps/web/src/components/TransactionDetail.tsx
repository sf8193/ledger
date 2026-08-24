import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';
import { X, ChevronDown, User, Search, Receipt, Wand2, Tag } from 'lucide-react';
import { RuleBuilderModal, type ExistingRule } from './RuleBuilderModal';
import { formatCurrency } from '../lib/spending';
import { ownerColorPalette, buildOwnerColors } from '../lib/owners';
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
  category?: JournalLine | null;
  tags?: Array<{ id: string; name: string }>;
}

interface Category {
  id: string;
  name: string;
  account_type: string;
}


function formatCurrencyAbs(amount: number): string {
  return formatCurrency(Math.abs(amount));
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function sourceLabel(source: string | null): string {
  if (!source) return 'Unknown';
  const labels: Record<string, string> = {
    plaid: 'Plaid',
    manual: 'Manual',
    import: 'Import',
    plaid_removed: 'Plaid (removed)',
    reconciliation: 'Reconciliation',
  };
  return labels[source] || source;
}

export function TransactionDetail({
  entry,
  onClose,
}: {
  entry: JournalEntry;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Editable state — initialized from entry
  const [categoryId, setCategoryId] = useState(entry.category?.account_id || '');
  const [owner, setOwner] = useState<string | null>(entry.owner);
  const [notes, setNotes] = useState(entry.notes || '');
  const [excludeFromTotals, setExcludeFromTotals] = useState(!!entry.exclude_from_totals);

  // Tags
  const [tagNames, setTagNames] = useState<string[]>((entry.tags || []).map(t => t.name));
  const [tagInput, setTagInput] = useState('');

  // Category dropdown
  const [catDropdownOpen, setCatDropdownOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const [showRuleBuilder, setShowRuleBuilder] = useState(false);
  const [editingRule, setEditingRule] = useState<ExistingRule | null>(null);
  const catRef = useRef<HTMLDivElement>(null);

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  // Fetch rules to enable editing existing rules from transaction detail
  const { data: rules } = useQuery<ExistingRule[]>({
    queryKey: ['rules'],
    queryFn: () => apiFetch('/matching/rules'),
  });

  // Find a rule that matches this transaction's merchant/description
  const matchedRule = useMemo(() => {
    if (!rules) return null;
    const merchant = entry.merchant_name?.toLowerCase();
    const desc = entry.description?.toLowerCase();
    return rules.find(r => {
      const val = r.match_value.toLowerCase();
      // Mirror matchmaker: merchant_name falls back to description
      const field = r.match_field === 'merchant_name' ? (merchant || desc) : desc;
      if (!field) return false;
      if (r.match_type === 'equals') return field === val;
      if (r.match_type === 'starts_with') return field.startsWith(val);
      return field.includes(val); // contains
    }) ?? null;
  }, [rules, entry.merchant_name, entry.description]);

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

  const { data: allTags } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['tags'],
    queryFn: () => apiFetch('/transactions/tags'),
  });

  const ownerOptions = useMemo(() => owners || [], [owners]);
  const ownerColors = useMemo(() => buildOwnerColors(ownerOptions), [ownerOptions]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!catDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatDropdownOpen(false);
        setCatSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [catDropdownOpen]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleClose = () => {
    setClosing(true);
    setTimeout(onClose, 300);
  };

  const isExpense = entry.amount > 0;
  const relevantCategories = (categories || []).filter((c) =>
    isExpense ? c.account_type === 'expense' : c.account_type === 'income'
  );
  const filteredCategories = catSearch
    ? relevantCategories.filter((c) => c.name.toLowerCase().includes(catSearch.toLowerCase()))
    : relevantCategories;

  const selectedCategoryName = relevantCategories.find((c) => c.id === categoryId)?.name;

  // Find the asset/liability line for account name display
  const assetLine = entry.lines.find(
    (l) => l.account_type !== 'expense' && l.account_type !== 'income'
  );

  const originalTagNames = (entry.tags || []).map(t => t.name).sort().join(',');
  const currentTagNames = [...tagNames].sort().join(',');
  const tagsDirty = currentTagNames !== originalTagNames;

  const isDirty =
    categoryId !== (entry.category?.account_id || '') ||
    owner !== entry.owner ||
    notes !== (entry.notes || '') ||
    excludeFromTotals !== !!entry.exclude_from_totals ||
    tagsDirty;

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (categoryId !== (entry.category?.account_id || '')) {
        body.category_id = categoryId || null;
      }
      if (owner !== entry.owner) {
        body.owner = owner;
      }
      if (notes !== (entry.notes || '')) {
        body.notes = notes || null;
      }
      if (excludeFromTotals !== !!entry.exclude_from_totals) {
        body.exclude_from_totals = excludeFromTotals;
      }
      if (tagsDirty) {
        body.tags = tagNames;
      }

      await apiFetch(`/transactions/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });

      toast.success('Transaction updated');
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      handleClose();
    } catch {
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    // Backdrop
    <div
      className={`fixed inset-0 z-50 ${closing ? 'animate-backdrop-out' : 'animate-backdrop-in'}`}
    >
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Blade panel */}
      <div
        className={`absolute top-0 right-0 h-full w-full md:w-[400px] bg-surface border-l border-border shadow-2xl flex flex-col ${
          closing ? 'animate-blade-out' : 'animate-blade-in'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-medium text-white">Transaction Detail</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          {/* Amount + merchant */}
          <div>
            <div
              className={`text-2xl font-medium tabular-nums ${
                entry.amount > 0 ? 'text-red-400' : entry.amount < 0 ? 'text-emerald-400' : 'text-slate-500'
              }`}
            >
              {entry.amount > 0 ? '-' : '+'}
              {formatCurrencyAbs(entry.amount)}
            </div>
            <div className="text-base text-white mt-1">
              {entry.merchant_name || entry.description}
            </div>
            {entry.merchant_name && entry.description !== entry.merchant_name && (
              <div className="text-xs text-slate-500 mt-0.5">{entry.description}</div>
            )}
          </div>

          {/* Meta row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>{formatDate(entry.date)}</span>
            {assetLine && <span>{assetLine.account_name}</span>}
            <span>{sourceLabel(entry.source)}</span>
          </div>

          <div className="h-px bg-border" />

          {/* Category */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Category</label>
            <div className="relative" ref={catRef}>
              <button
                onClick={() => setCatDropdownOpen(!catDropdownOpen)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${
                  categoryId
                    ? 'bg-primary/10 border border-primary/30 text-primary'
                    : 'bg-surface-lighter border border-border text-slate-400 hover:text-white'
                }`}
              >
                <span>{selectedCategoryName || 'Uncategorized'}</span>
                <ChevronDown
                  size={14}
                  className={`transition-transform duration-150 ${catDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {catDropdownOpen && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in">
                  <div className="p-2 border-b border-border">
                    <div className="relative">
                      <Search
                        size={12}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                      />
                      <input
                        type="text"
                        value={catSearch}
                        onChange={(e) => setCatSearch(e.target.value)}
                        placeholder="Search categories..."
                        className="w-full pl-7 pr-2.5 py-1.5 rounded bg-background border border-border text-white text-xs placeholder-slate-600"
                        autoFocus
                      />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {filteredCategories.length > 0 ? (
                      filteredCategories.map((cat) => (
                        <button
                          key={cat.id}
                          onClick={() => {
                            setCategoryId(cat.id);
                            setCatDropdownOpen(false);
                            setCatSearch('');
                          }}
                          className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                            categoryId === cat.id
                              ? 'bg-primary/10 text-primary'
                              : 'text-slate-300 hover:bg-white/5'
                          }`}
                        >
                          {cat.name}
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-3 text-xs text-slate-500 text-center">
                        No categories match
                      </div>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      const name = catSearch.trim() || prompt('Category name:');
                      if (!name) return;
                      try {
                        const result = await apiFetch<{ id: string }>('/categories', {
                          method: 'POST',
                          body: JSON.stringify({ name, is_income: !isExpense }),
                        });
                        queryClient.invalidateQueries({ queryKey: ['categories'] });
                        setCategoryId(result.id);
                        setCatDropdownOpen(false);
                        setCatSearch('');
                        toast.success(`Created "${name}"`);
                      } catch {
                        toast.error('Failed to create category');
                      }
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-emerald-400 hover:bg-emerald-400/10 transition-colors border-t border-border"
                  >
                    + New category{catSearch.trim() ? ` "${catSearch.trim()}"` : ''}
                  </button>
                </div>
              )}
            </div>

            {/* Create/edit rule button */}
            {(entry.merchant_name || entry.description) && (
              <button
                onClick={() => { setEditingRule(matchedRule); setShowRuleBuilder(true); }}
                className="flex items-center gap-1.5 mt-2 text-xs text-slate-500 hover:text-primary transition-colors"
              >
                <Wand2 size={11} />
                {matchedRule ? 'Edit rule for this merchant' : 'Create rule for this merchant'}
              </button>
            )}
            {entry.categorized_by && (
              <p className="mt-1.5 text-[10px] text-slate-600 italic">
                {entry.categorized_by === 'plaid' && 'Categorized by Plaid taxonomy'}
                {entry.categorized_by === 'merchant-history' && `Matched previous "${entry.merchant_name}" entry`}
                {entry.categorized_by === 'transfer-match' && 'Auto-matched as transfer'}
                {entry.categorized_by === 'user' && 'Set manually'}
                {entry.categorized_by.startsWith('rule:') && `Rule: "${entry.categorized_by.slice(5)}"`}
              </p>
            )}
          </div>

          {/* Owner */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Owner</label>
            <div className="flex items-center gap-2 flex-wrap">
              {ownerOptions.map((o) => {
                const isActive = owner === o;
                const colors = ownerColors[o] || ownerColorPalette[0];
                return (
                  <button
                    key={o}
                    onClick={() => setOwner(isActive ? null : o)}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs border transition-colors duration-150 ${
                      isActive ? colors.active : colors.inactive
                    }`}
                  >
                    <User size={10} />
                    {demoText(o)}
                  </button>
                );
              })}
            </div>
            {owner === null && entry.owner !== null && (
              <div className="text-xs text-amber-400/70 mt-1.5">Owner removed</div>
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Tags</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tagNames.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-500/15 text-slate-300 text-xs"
                >
                  <Tag size={10} />
                  {tag}
                  <button
                    onClick={() => setTagNames(tagNames.filter(t => t !== tag))}
                    className="ml-0.5 text-slate-500 hover:text-white transition-colors"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="relative">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const trimmed = tagInput.trim().replace(/,/g, '');
                    if (trimmed && !tagNames.includes(trimmed)) {
                      setTagNames([...tagNames, trimmed]);
                    }
                    setTagInput('');
                  } else if (e.key === 'Backspace' && !tagInput && tagNames.length > 0) {
                    setTagNames(tagNames.slice(0, -1));
                  }
                }}
                placeholder={tagNames.length > 0 ? 'Add another...' : 'Add tags (press Enter)'}
                className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600"
                list="tag-suggestions"
              />
              {tagInput && allTags && allTags.filter(t => t.name.toLowerCase().includes(tagInput.toLowerCase()) && !tagNames.includes(t.name)).length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in">
                  <div className="max-h-32 overflow-y-auto">
                    {allTags
                      .filter(t => t.name.toLowerCase().includes(tagInput.toLowerCase()) && !tagNames.includes(t.name))
                      .map(t => (
                        <button
                          key={t.id}
                          onClick={() => {
                            setTagNames([...tagNames, t.name]);
                            setTagInput('');
                          }}
                          className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5 transition-colors"
                        >
                          {t.name}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add a note..."
              rows={3}
              className="w-full px-3 py-2.5 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600 resize-none"
            />
          </div>

          {/* Reimbursement — only for expenses */}
          {entry.amount > 0 && (
            <ReimbursementToggle
              entryId={entry.id}
              status={entry.reimbursement_status || null}
              onChanged={(exclude) => {
                setExcludeFromTotals(exclude);
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                queryClient.invalidateQueries({ queryKey: ['reimbursements-pending'] });
              }}
            />
          )}

          {/* Exclude from totals */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white">Exclude from totals</div>
              <div className="text-xs text-slate-500">Hide from spending and net worth</div>
            </div>
            <button
              onClick={() => setExcludeFromTotals(!excludeFromTotals)}
              className={`relative w-10 h-[22px] rounded-full transition-colors duration-150 ${
                excludeFromTotals ? 'bg-primary' : 'bg-surface-lighter border border-border'
              }`}
            >
              <div
                className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-150 ${
                  excludeFromTotals ? 'translate-x-[22px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border">
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 bg-primary text-white hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>

      {showRuleBuilder && (
        <RuleBuilderModal
          onClose={() => { setShowRuleBuilder(false); setEditingRule(null); }}
          existingRule={editingRule ?? undefined}
          prefill={editingRule ? undefined : {
            entryId: entry.id,
            merchantName: entry.merchant_name,
            description: entry.description,
            isExpense: entry.amount > 0,
          }}
        />
      )}
    </div>
  );
}

function ReimbursementToggle({
  entryId,
  status,
  onChanged,
}: {
  entryId: string;
  status: 'pending' | 'reimbursed' | null;
  onChanged: (exclude: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (status === 'pending') {
        await apiFetch('/reimbursements/unmark', {
          method: 'POST',
          body: JSON.stringify({ entry_id: entryId }),
        });
        toast.success('Removed from reimbursements');
        onChanged(false);
      } else if (!status) {
        await apiFetch('/reimbursements/mark', {
          method: 'POST',
          body: JSON.stringify({ entry_id: entryId }),
        });
        toast.success('Marked for reimbursement');
        onChanged(true);
      }
    } catch (err) {
      toast.error((err as Error).message || 'Failed to update');
    } finally {
      setLoading(false);
    }
  };

  if (status === 'reimbursed') {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-400/70">
        <Receipt size={12} />
        <span>Reimbursed</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm text-white">Reimbursement</div>
        <div className="text-xs text-slate-500">
          {status === 'pending' ? 'Pending — excluded from spending' : 'Mark as pending reimbursement'}
        </div>
      </div>
      <button
        onClick={handleToggle}
        disabled={loading}
        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
          status === 'pending'
            ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25'
            : 'text-slate-500 border-border hover:text-amber-400 hover:border-amber-500/20'
        } disabled:opacity-50`}
      >
        <Receipt size={10} className="inline mr-1" />
        {status === 'pending' ? 'Pending' : 'Mark'}
      </button>
    </div>
  );
}
