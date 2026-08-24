import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';
import { X, Plus, Trash2, AlertCircle } from 'lucide-react';

interface Account {
  id: string;
  name: string;
  account_type: string;
  institution_name: string | null;
}

type EntryType = 'expense' | 'income' | 'transfer';

export function ManualEntryForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [entryType, setEntryType] = useState<EntryType>('expense');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');

  // Simple mode: two accounts
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');

  // Split mode: arbitrary lines
  const [splitMode, setSplitMode] = useState(false);
  const [lines, setLines] = useState<{ account_id: string; amount: string }[]>([
    { account_id: '', amount: '' },
    { account_id: '', amount: '' },
  ]);

  const { data: allAccounts } = useQuery<Account[]>({
    queryKey: ['all-accounts'],
    queryFn: () => apiFetch('/accounts'),
  });

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

  const [owner, setOwner] = useState<string | null>(null);

  // Group accounts by type
  const bankAccounts = useMemo(
    () => (allAccounts || []).filter((a) => ['asset', 'liability'].includes(a.account_type)),
    [allAccounts]
  );
  const expenseAccounts = useMemo(
    () => (allAccounts || []).filter((a) => a.account_type === 'expense'),
    [allAccounts]
  );
  const incomeAccounts = useMemo(
    () => (allAccounts || []).filter((a) => a.account_type === 'income'),
    [allAccounts]
  );

  // Auto-select first bank account
  useEffect(() => {
    if (bankAccounts.length > 0 && !fromAccountId) {
      setFromAccountId(bankAccounts[0].id);
    }
  }, [bankAccounts, fromAccountId]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 300);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // Compute lines for simple mode — round to cents to match backend validation
  const computedLines = useMemo(() => {
    if (splitMode) {
      return lines.map((l) => ({
        account_id: l.account_id,
        amount: Math.round((parseFloat(l.amount) || 0) * 100) / 100,
      }));
    }

    const amt = Math.round((parseFloat(amount) || 0) * 100) / 100;
    if (amt === 0 || !fromAccountId || !toAccountId) return [];

    if (entryType === 'expense') {
      // Debit expense account, credit bank account
      return [
        { account_id: toAccountId, amount: amt },
        { account_id: fromAccountId, amount: -amt },
      ];
    } else if (entryType === 'income') {
      // Debit bank account, credit income account
      return [
        { account_id: fromAccountId, amount: amt },
        { account_id: toAccountId, amount: -amt },
      ];
    } else {
      // Transfer: debit destination, credit source
      return [
        { account_id: toAccountId, amount: amt },
        { account_id: fromAccountId, amount: -amt },
      ];
    }
  }, [splitMode, lines, amount, fromAccountId, toAccountId, entryType]);

  const lineSum = computedLines.reduce((s, l) => s + Math.round(l.amount * 100) / 100, 0);
  const isBalanced = Math.abs(Math.round(lineSum * 100) / 100) < 0.01;
  const hasValidAccounts = computedLines.every((l) => l.account_id);
  const hasAmount = computedLines.some((l) => l.amount !== 0);
  const canSubmit = description.trim() && isBalanced && hasValidAccounts && hasAmount && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await apiFetch('/transactions', {
        method: 'POST',
        body: JSON.stringify({
          date,
          description: description.trim(),
          notes: notes.trim() || null,
          owner,
          lines: computedLines,
        }),
      });
      toast.success('Entry created');
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      handleClose();
    } catch (err) {
      toast.error((err as Error).message || 'Failed to create entry');
    } finally {
      setSaving(false);
    }
  };

  const addLine = () => setLines([...lines, { account_id: '', amount: '' }]);
  const removeLine = (i: number) => {
    if (lines.length <= 2) return;
    setLines(lines.filter((_, idx) => idx !== i));
  };
  const updateLine = (i: number, field: 'account_id' | 'amount', value: string) => {
    const next = [...lines];
    next[i] = { ...next[i], [field]: value };
    setLines(next);
  };

  // Labels for "from" and "to" based on entry type
  const fromLabel = entryType === 'income' ? 'To account' : 'From account';
  const toLabel =
    entryType === 'expense' ? 'Category' : entryType === 'income' ? 'Income source' : 'To account';

  // Options for the "to" dropdown based on type
  const toOptions =
    entryType === 'expense'
      ? expenseAccounts
      : entryType === 'income'
        ? incomeAccounts
        : bankAccounts;

  return (
    <div className={`fixed inset-0 z-50 ${closing ? 'animate-backdrop-out' : 'animate-backdrop-in'}`}>
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      <div
        className={`absolute top-0 right-0 h-full w-full md:w-[440px] bg-surface border-l border-border shadow-2xl flex flex-col ${
          closing ? 'animate-blade-out' : 'animate-blade-in'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-medium text-white">New Entry</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Entry type tabs */}
          {!splitMode && (
            <div className="flex rounded-lg bg-background border border-border p-0.5">
              {(['expense', 'income', 'transfer'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setEntryType(t);
                    setToAccountId('');
                  }}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    entryType === t
                      ? 'bg-surface-lighter text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          )}

          {/* Date */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm [color-scheme:dark]"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Coffee, ATM withdrawal, Rent payment"
              className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600"
              autoFocus
            />
          </div>

          {!splitMode ? (
            <>
              {/* Amount */}
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                    className="w-full pl-7 pr-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600 tabular-nums"
                  />
                </div>
              </div>

              {/* From account */}
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">{fromLabel}</label>
                <select
                  value={fromAccountId}
                  onChange={(e) => setFromAccountId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm appearance-none"
                >
                  <option value="">Select account...</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.institution_name ? ` (${a.institution_name})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* To account / category */}
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">{toLabel}</label>
                <select
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm appearance-none"
                >
                  <option value="">Select {toLabel.toLowerCase()}...</option>
                  {toOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              {/* Split mode: arbitrary journal lines */}
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Journal Lines</label>
                <div className="space-y-2">
                  {lines.map((line, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={line.account_id}
                        onChange={(e) => updateLine(i, 'account_id', e.target.value)}
                        className="flex-1 px-2 py-2 rounded-lg bg-surface-lighter border border-border text-white text-xs appearance-none"
                      >
                        <option value="">Account...</option>
                        <optgroup label="Bank Accounts">
                          {bankAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Expenses">
                          {expenseAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Income">
                          {incomeAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </optgroup>
                      </select>
                      <input
                        type="number"
                        value={line.amount}
                        onChange={(e) => updateLine(i, 'amount', e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        className="w-28 px-2 py-2 rounded-lg bg-surface-lighter border border-border text-white text-xs tabular-nums placeholder-slate-600"
                      />
                      <button
                        onClick={() => removeLine(i)}
                        disabled={lines.length <= 2}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-red-400 disabled:opacity-20 disabled:hover:text-slate-500 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addLine}
                  className="flex items-center gap-1 mt-2 text-xs text-slate-500 hover:text-primary transition-colors"
                >
                  <Plus size={12} /> Add line
                </button>
              </div>

              {/* Balance indicator */}
              {lines.some((l) => l.amount) && (
                <div
                  className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg ${
                    isBalanced
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-red-500/10 text-red-400'
                  }`}
                >
                  {isBalanced ? (
                    <span>Balanced (sum = $0.00)</span>
                  ) : (
                    <>
                      <AlertCircle size={12} />
                      <span>
                        Out of balance: {lineSum >= 0 ? '+' : ''}
                        {lineSum.toFixed(2)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* Owner */}
          {owners && owners.length > 0 && (
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">Owner</label>
              <div className="flex items-center gap-2 flex-wrap">
                {owners.map((o) => (
                  <button
                    key={o}
                    onClick={() => setOwner(owner === o ? null : o)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                      owner === o
                        ? 'bg-primary/15 text-primary border-primary/30'
                        : 'text-slate-500 border-border hover:text-white hover:border-white/20'
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600 resize-none"
            />
          </div>

          {/* Toggle split mode */}
          <button
            onClick={() => {
              if (!splitMode && amount && fromAccountId && toAccountId) {
                // Seed split lines from simple-mode state
                const amt = Math.round((parseFloat(amount) || 0) * 100) / 100;
                if (amt !== 0) {
                  const debitId = entryType === 'income' ? fromAccountId : toAccountId;
                  const creditId = entryType === 'income' ? toAccountId : fromAccountId;
                  setLines([
                    { account_id: debitId, amount: String(amt) },
                    { account_id: creditId, amount: String(-amt) },
                  ]);
                }
              }
              setSplitMode(!splitMode);
            }}
            className="text-xs text-slate-500 hover:text-primary transition-colors"
          >
            {splitMode ? 'Switch to simple mode' : 'Advanced: split entry'}
          </button>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 bg-primary text-white hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? 'Creating...' : 'Create entry'}
          </button>
        </div>
      </div>
    </div>
  );
}
