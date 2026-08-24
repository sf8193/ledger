import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Receipt, X, Check, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryError, ListSkeleton } from '../components/QueryState';
import { formatCurrency } from '../lib/spending';
import { demoText } from '../hooks/useDemo';

interface PendingEntry {
  id: string;
  description: string;
  merchant_name: string | null;
  date: string;
  owner: string | null;
  expense_amount: number;
}

interface PendingResponse {
  data: PendingEntry[];
  totalPending: number;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ReimbursementsPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [unmarking, setUnmarking] = useState<string | null>(null);

  const { data: response, isLoading, isError, error, refetch } = useQuery<PendingResponse>({
    queryKey: ['reimbursements-pending'],
    queryFn: () => apiFetch('/reimbursements/pending'),
  });

  const entries = response?.data || [];
  const totalPending = response?.totalPending || 0;

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map((e) => e.id)));
    }
  };

  const selectedTotal = entries
    .filter((e) => selected.has(e.id))
    .reduce((sum, e) => sum + e.expense_amount, 0);

  const handleUnmark = async (id: string) => {
    setUnmarking(id);
    try {
      await apiFetch('/reimbursements/unmark', {
        method: 'POST',
        body: JSON.stringify({ entry_id: id }),
      });
      toast.success('Removed from reimbursements');
      queryClient.invalidateQueries({ queryKey: ['reimbursements-pending'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      selected.delete(id);
      setSelected(new Set(selected));
    } catch (err) {
      toast.error((err as Error).message || 'Failed to unmark');
    } finally {
      setUnmarking(null);
    }
  };

  const handleApply = async () => {
    if (selected.size === 0) return;
    setApplying(true);
    setShowConfirm(false);
    try {
      await apiFetch('/reimbursements/apply', {
        method: 'POST',
        body: JSON.stringify({
          expense_entry_ids: Array.from(selected),
        }),
      });
      toast.success(`${selected.size} expense${selected.size !== 1 ? 's' : ''} marked as reimbursed`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['reimbursements-pending'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch (err) {
      toast.error((err as Error).message || 'Failed to apply reimbursement');
    } finally {
      setApplying(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Reimbursements</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load reimbursements'} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Reimbursements</h1>
        <p className="text-sm text-slate-500 mt-1">
          {entries.length > 0
            ? `${entries.length} pending · ${formatCurrency(totalPending)} total`
            : 'No pending reimbursements'}
        </p>
      </div>

      {entries.length > 0 ? (
        <>
          {/* Selection toolbar */}
          <div className="flex items-center justify-between">
            <button
              onClick={selectAll}
              className="text-xs text-slate-400 hover:text-white transition-colors"
            >
              {selected.size === entries.length ? 'Deselect all' : 'Select all'}
            </button>
            {selected.size > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">
                  {selected.size} selected · {formatCurrency(selectedTotal)}
                </span>
                <button
                  onClick={() => setShowConfirm(true)}
                  disabled={applying}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-30 transition-colors"
                >
                  <Check size={12} />
                  {applying ? 'Applying...' : 'Mark reimbursed'}
                </button>
              </div>
            )}
          </div>

          {/* Entries list */}
          <div className="card divide-y divide-border">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors group"
              >
                {/* Checkbox */}
                <button
                  onClick={() => toggleSelect(entry.id)}
                  className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                    selected.has(entry.id)
                      ? 'bg-primary border-primary text-white'
                      : 'border-border hover:border-slate-500'
                  }`}
                >
                  {selected.has(entry.id) && <Check size={12} />}
                </button>

                {/* Entry info */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">
                    {entry.merchant_name || entry.description}
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-2">
                    <span>{formatDate(entry.date)}</span>
                    {entry.owner && (
                      <span className="text-slate-600">{demoText(entry.owner)}</span>
                    )}
                  </div>
                </div>

                {/* Amount */}
                <div className="text-sm font-medium tabular-nums text-red-400 flex-shrink-0">
                  {formatCurrency(entry.expense_amount)}
                </div>

                {/* Unmark button */}
                <button
                  onClick={() => handleUnmark(entry.id)}
                  disabled={unmarking === entry.id}
                  title="Remove from reimbursements"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="card px-5 py-12 text-center">
          <Receipt size={28} className="text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-white">All caught up</p>
          <p className="text-xs text-slate-500 mt-1">
            Mark expenses as reimbursable from the transaction detail blade
          </p>
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center animate-backdrop-in">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowConfirm(false)} />
          <div className="relative card p-6 max-w-sm mx-4 space-y-4 animate-fade-in">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertTriangle size={16} />
              <h3 className="text-sm font-medium">Confirm reimbursement</h3>
            </div>
            <p className="text-sm text-slate-300">
              Mark <span className="text-white font-medium">{selected.size} expense{selected.size !== 1 ? 's' : ''}</span> totaling{' '}
              <span className="text-white font-medium tabular-nums">{formatCurrency(selectedTotal)}</span> as reimbursed?
            </p>
            <p className="text-xs text-slate-500">
              These expenses are already excluded from spending totals. This action records them as reimbursed.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={applying}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-30 transition-colors"
              >
                {applying ? 'Applying...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
