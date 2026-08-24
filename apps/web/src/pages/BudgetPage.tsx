import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { QueryError } from '../components/QueryState';
import { formatCurrency } from '../lib/spending';
import { isDemoMode } from '../hooks/useDemo';
import { Plus, Trash2, ChevronLeft, ChevronRight, Zap, Lightbulb, ArrowRight, PiggyBank } from 'lucide-react';

interface BudgetItem {
  id: string;
  categoryId: string;
  categoryName: string;
  icon: string | null;
  color: string | null;
  monthlyAmount: number;
  priority: number;
  rolloverCap: number | null;
  assigned: number;
  spent: number;
  rollover: number;
  available: number;
}

interface BudgetResponse {
  month: string;
  readyToAssign: number;
  monthIncome: number;
  surplusCategoryId: string | null;
  budgets: BudgetItem[];
}

interface Category {
  id: string;
  name: string;
  account_type: string;
}

interface Suggestion {
  categoryId: string;
  categoryName: string;
  avgMonthly: number;
  monthsActive: number;
  currentBudget: number | null;
  suggestedAmount: number;
}

function amt(v: number) {
  return isDemoMode() ? '$••••' : formatCurrency(v);
}

export function BudgetPage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [adding, setAdding] = useState(false);
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editingAllocId, setEditingAllocId] = useState<string | null>(null);
  const [editAllocAmount, setEditAllocAmount] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [movingFrom, setMovingFrom] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [moveAmount, setMoveAmount] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery<BudgetResponse>({
    queryKey: ['budgets', month],
    queryFn: () => apiFetch(`/budgets?month=${month}`),
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  const { data: suggestions } = useQuery<{ suggestions: Suggestion[] }>({
    queryKey: ['budget-suggestions'],
    queryFn: () => apiFetch('/budgets/suggest-targets?months=3'),
    enabled: showSuggestions,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['budgets'] });

  const createMutation = useMutation({
    mutationFn: (body: { category_id: string; monthly_amount: number }) =>
      apiFetch('/budgets', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setAdding(false); setNewCategoryId(''); setNewAmount(''); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; monthly_amount?: number }) =>
      apiFetch(`/budgets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setEditingId(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/budgets/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const allocateMutation = useMutation({
    mutationFn: (body: { category_id: string; month: string; assigned: number }) =>
      apiFetch('/budgets/allocate', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setEditingAllocId(null); },
  });

  const autoAssignMutation = useMutation({
    mutationFn: () => apiFetch('/budgets/auto-assign', { method: 'POST', body: JSON.stringify({ month }) }),
    onSuccess: invalidate,
  });

  const moveMutation = useMutation({
    mutationFn: (body: { from_category_id: string; to_category_id: string; month: string; amount: number }) =>
      apiFetch('/budgets/move', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setMovingFrom(null); setMoveTo(''); setMoveAmount(''); },
  });

  const availableCategories = useMemo(() => {
    if (!categories || !data) return [];
    const budgeted = new Set(data.budgets.map(b => b.categoryId));
    return categories.filter(c => c.account_type === 'expense' && !budgeted.has(c.id));
  }, [categories, data]);

  const unbudgetedSuggestions = useMemo(() => {
    if (!suggestions || !data) return [];
    const budgeted = new Set(data.budgets.map(b => b.categoryId));
    return suggestions.suggestions.filter(s => !budgeted.has(s.categoryId));
  }, [suggestions, data]);

  const shiftMonth = (delta: number) => {
    const d = new Date(month + '-01');
    d.setMonth(d.getMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
  };

  const monthLabel = useMemo(() => {
    const d = new Date(month + '-01');
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }, [month]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        <div className="h-24 bg-surface rounded-xl animate-pulse" />
        <div className="h-64 bg-surface rounded-xl animate-pulse" />
      </div>
    );
  }

  if (isError) return <QueryError message={error?.message || 'Failed to load'} onRetry={() => refetch()} />;

  if (data && data.budgets.length === 0 && !adding) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-white">Budget</h2>
        <div className="card px-5 py-12 text-center">
          <PiggyBank size={32} className="text-slate-700 mx-auto mb-3" />
          <p className="text-sm text-white mb-1">No budgets set up yet</p>
          <p className="text-xs text-slate-500 mb-5">Set monthly spending targets for your categories to track where your money goes.</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setAdding(true)} className="px-4 py-2 rounded-lg bg-primary/15 text-primary text-sm hover:bg-primary/25 transition-colors">
              Add manually
            </button>
            <button onClick={() => { setShowSuggestions(true); }} className="px-4 py-2 rounded-lg border border-border text-slate-400 text-sm hover:text-white hover:bg-white/5 transition-colors">
              Suggest from spending
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h2 className="text-xl font-semibold text-white">Budget</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => setShowSuggestions(!showSuggestions)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors border ${
              showSuggestions ? 'bg-amber-400/10 border-amber-400/30 text-amber-400' : 'border-border text-slate-500 hover:text-slate-300'
            }`}>
            <Lightbulb size={14} /> Smart targets
          </button>
          <button onClick={() => autoAssignMutation.mutate()} disabled={autoAssignMutation.isPending}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40">
            <Zap size={14} /> {autoAssignMutation.isPending ? 'Filling...' : 'Auto-assign'}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => shiftMonth(-1)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm text-slate-300 min-w-[140px] text-center">{monthLabel}</span>
            <button onClick={() => shiftMonth(1)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Smart targets */}
      {showSuggestions && unbudgetedSuggestions.length > 0 && (
        <div className="bg-amber-400/5 rounded-xl border border-amber-400/20 p-4 mb-6">
          <div className="text-xs text-amber-400 font-medium mb-3">Suggested from your spending (3-month avg)</div>
          <div className="space-y-2">
            {unbudgetedSuggestions.map(s => (
              <div key={s.categoryId} className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-white">{s.categoryName}</span>
                  <span className="text-xs text-slate-500 ml-2">avg {amt(s.avgMonthly)}/mo</span>
                </div>
                <button onClick={() => createMutation.mutate({ category_id: s.categoryId, monthly_amount: Math.ceil(s.suggestedAmount) })}
                  className="px-2 py-1 rounded text-xs bg-primary/15 text-primary hover:bg-primary/25 transition-colors">
                  Add at {amt(Math.ceil(s.suggestedAmount))}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ready to Assign */}
      {data && (
        <div className={`rounded-xl border p-4 mb-6 ${
          data.readyToAssign < 0 ? 'bg-red-400/10 border-red-400/30'
            : data.readyToAssign === 0 ? 'bg-emerald-400/10 border-emerald-400/30'
            : 'bg-amber-400/10 border-amber-400/30'
        }`}>
          <div className="text-xs text-gray-400 mb-1">Ready to Assign</div>
          <div className={`text-2xl font-semibold tabular-nums ${
            data.readyToAssign < 0 ? 'text-red-400' : data.readyToAssign === 0 ? 'text-emerald-400' : 'text-amber-400'
          }`}>{amt(data.readyToAssign)}</div>
          <div className="text-xs text-slate-500 mt-1">{amt(data.monthIncome)} income this month</div>
        </div>
      )}

      {/* Move money panel */}
      {movingFrom && data && (
        <div className="bg-surface rounded-xl border border-primary/30 p-4 mb-6">
          <div className="text-xs text-primary font-medium mb-3 flex items-center gap-2">
            <ArrowRight size={14} />
            Move money from {data.budgets.find(b => b.categoryId === movingFrom)?.categoryName}
          </div>
          <form onSubmit={e => {
            e.preventDefault();
            const a = parseFloat(moveAmount);
            if (moveTo && a > 0) moveMutation.mutate({ from_category_id: movingFrom, to_category_id: moveTo, month, amount: a });
          }} className="flex items-center gap-3">
            <select value={moveTo} onChange={e => setMoveTo(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm text-white">
              <option value="">Move to...</option>
              {data.budgets.filter(b => b.categoryId !== movingFrom).map(b => (
                <option key={b.categoryId} value={b.categoryId}>{b.categoryName}</option>
              ))}
            </select>
            <input type="number" step="0.01" min="0.01" placeholder="Amount" value={moveAmount} onChange={e => setMoveAmount(e.target.value)}
              className="w-28 px-3 py-2 rounded-lg bg-background border border-border text-sm text-white tabular-nums" />
            <button type="submit" disabled={!moveTo || !moveAmount || moveMutation.isPending}
              className="px-3 py-2 rounded-lg bg-primary/15 text-primary text-sm hover:bg-primary/25 transition-colors disabled:opacity-40">Move</button>
            <button type="button" onClick={() => { setMovingFrom(null); setMoveTo(''); setMoveAmount(''); }}
              className="text-sm text-slate-500 hover:text-slate-300">Cancel</button>
          </form>
        </div>
      )}

      {/* Envelope list */}
      <div className="bg-surface rounded-xl border border-border">
        {data && data.budgets.length > 0 && (
          <>
            {/* Column headers */}
            {data && data.budgets.length > 0 && (
              <div className="px-5 py-2.5 flex items-center text-[11px] text-slate-600 uppercase tracking-wider border-b border-border">
                <span className="flex-1">Category</span>
                <span className="w-24 text-right">Assigned</span>
                <span className="w-24 text-right">Spent</span>
                <span className="w-24 text-right">Available</span>
                <span className="w-20" />
              </div>
            )}

            <div className="divide-y divide-border">
              {data?.budgets.map(b => {
                const isEditingAlloc = editingAllocId === b.id;
                const isEditingTarget = editingId === b.id;
                const underfunded = b.assigned < b.monthlyAmount;

                return (
                  <div key={b.id} className="px-5 py-3 flex items-center gap-2">
                    {/* Category + target */}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-white">{b.categoryName}</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        {isEditingTarget ? (
                          <form onSubmit={e => { e.preventDefault(); const v = parseFloat(editAmount); if (v > 0) updateMutation.mutate({ id: b.id, monthly_amount: v }); }} className="flex items-center gap-1">
                            <input type="number" step="0.01" min="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)}
                              className="w-20 px-1.5 py-0.5 rounded bg-background border border-border text-[11px] text-white text-right tabular-nums" autoFocus />
                            <button type="submit" className="text-[11px] text-primary">Save</button>
                            <button type="button" onClick={() => setEditingId(null)} className="text-[11px] text-slate-500">Cancel</button>
                          </form>
                        ) : (
                          <button onClick={() => { setEditingId(b.id); setEditAmount(String(b.monthlyAmount)); }}
                            className="text-[11px] text-slate-600 hover:text-slate-400 tabular-nums">
                            Target: {amt(b.monthlyAmount)}
                          </button>
                        )}
                        {b.rollover !== 0 && (
                          <span className={`text-[11px] tabular-nums ${b.rollover > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {b.rollover > 0 ? '+' : ''}{amt(b.rollover)} rollover
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Assigned */}
                    <div className="w-24 text-right">
                      {isEditingAlloc ? (
                        <form onSubmit={e => { e.preventDefault(); const v = parseFloat(editAllocAmount); if (v >= 0) allocateMutation.mutate({ category_id: b.categoryId, month, assigned: v }); }} className="flex items-center justify-end gap-1">
                          <input type="number" step="0.01" min="0" value={editAllocAmount} onChange={e => setEditAllocAmount(e.target.value)}
                            className="w-20 px-1.5 py-0.5 rounded bg-background border border-border text-xs text-white text-right tabular-nums" autoFocus />
                          <button type="submit" className="text-[11px] text-primary">OK</button>
                          <button type="button" onClick={() => setEditingAllocId(null)} className="text-[11px] text-slate-500">X</button>
                        </form>
                      ) : (
                        <button onClick={() => { setEditingAllocId(b.id); setEditAllocAmount(String(b.assigned)); }}
                          className={`text-sm tabular-nums transition-colors ${underfunded ? 'text-amber-400 hover:text-amber-300' : 'text-slate-300 hover:text-white'}`}>
                          {amt(b.assigned)}
                        </button>
                      )}
                    </div>

                    {/* Spent */}
                    <div className="w-24 text-right">
                      <span className="text-sm tabular-nums text-slate-400">{amt(b.spent)}</span>
                    </div>

                    {/* Available */}
                    <div className="w-24 text-right">
                      <span className={`text-sm font-medium tabular-nums ${
                        b.available < 0 ? 'text-red-400' : b.available === 0 ? 'text-slate-500' : 'text-emerald-400'
                      }`}>{amt(b.available)}</span>
                    </div>

                    {/* Actions */}
                    <div className="w-20 flex items-center justify-end gap-1">
                      <button onClick={() => { setMovingFrom(b.categoryId); setMoveTo(''); setMoveAmount(''); }}
                        title="Move money"
                        className="text-slate-700 hover:text-primary transition-colors p-1">
                        <ArrowRight size={13} />
                      </button>
                      <button onClick={() => deleteMutation.mutate(b.id)}
                        className="text-slate-700 hover:text-red-400 transition-colors p-1">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Add envelope */}
              {adding ? (
                <form onSubmit={e => { e.preventDefault(); const val = parseFloat(newAmount); if (newCategoryId && val > 0) createMutation.mutate({ category_id: newCategoryId, monthly_amount: val }); }}
                  className="px-5 py-4 flex items-center gap-3">
                  <select value={newCategoryId} onChange={e => setNewCategoryId(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm text-white">
                    <option value="">Select category...</option>
                    {availableCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input type="number" step="0.01" min="0.01" placeholder="Target" value={newAmount} onChange={e => setNewAmount(e.target.value)}
                    className="w-28 px-3 py-2 rounded-lg bg-background border border-border text-sm text-white tabular-nums" />
                  <button type="submit" disabled={!newCategoryId || !newAmount || createMutation.isPending}
                    className="px-3 py-2 rounded-lg bg-primary/15 text-primary text-sm hover:bg-primary/25 transition-colors disabled:opacity-40">Add</button>
                  <button type="button" onClick={() => { setAdding(false); setNewCategoryId(''); setNewAmount(''); }}
                    className="text-sm text-slate-500 hover:text-slate-300">Cancel</button>
                </form>
              ) : (
                <button onClick={() => setAdding(true)}
                  className="w-full px-5 py-3 flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 hover:bg-white/[0.02] transition-colors">
                  <Plus size={16} /> Add envelope
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
