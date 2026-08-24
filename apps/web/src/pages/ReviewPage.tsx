import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { GitMerge, Check, X, AlertCircle } from 'lucide-react';
import { formatCurrency } from '../lib/spending';
import { toast } from 'sonner';

interface MatchSuggestion {
  id: string;
  match_type: string;
  confidence: number;
  entry_a_id: string;
  entry_a_description: string;
  entry_a_date: string;
  entry_a_merchant: string | null;
  entry_b_id: string | null;
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

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ReviewPage() {
  const queryClient = useQueryClient();

  const { data: suggestions } = useQuery<MatchSuggestion[]>({
    queryKey: ['match-suggestions'],
    queryFn: () => apiFetch('/matching/suggestions'),
  });

  const { data: uncategorizedData } = useQuery<{ data: UncategorizedEntry[]; total: number }>({
    queryKey: ['uncategorized'],
    queryFn: () => apiFetch('/matching/uncategorized'),
  });

  const handleConfirm = async (id: string) => {
    await apiFetch(`/matching/suggestions/${id}/confirm`, { method: 'POST' });
    toast.success('Transfer confirmed');
    queryClient.invalidateQueries({ queryKey: ['match-suggestions'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  };

  const handleDismiss = async (id: string) => {
    await apiFetch(`/matching/suggestions/${id}/dismiss`, { method: 'POST' });
    toast.success('Dismissed');
    queryClient.invalidateQueries({ queryKey: ['match-suggestions'] });
  };

  const uncategorized = uncategorizedData?.data || [];
  const hasSuggestions = suggestions && suggestions.length > 0;
  const hasUncategorized = uncategorized.length > 0;

  if (!hasSuggestions && !hasUncategorized) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Review</h1>
          <p className="text-sm text-slate-500 mt-1">Match transfers and categorize transactions</p>
        </div>
        <div className="card px-5 py-12 text-center">
          <Check size={32} className="text-emerald-400 mx-auto mb-3" />
          <p className="text-sm text-white">All caught up</p>
          <p className="text-xs text-slate-500 mt-1">No pending matches or uncategorized transactions</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Review</h1>
        <p className="text-sm text-slate-500 mt-1">
          {(suggestions?.length || 0) + uncategorized.length} items need attention
        </p>
      </div>

      {/* Transfer suggestions */}
      {hasSuggestions && (
        <div>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Transfer Matches ({suggestions.length})
          </h2>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <div key={s.id} className="card p-4 animate-fade-in">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <GitMerge size={16} className="text-accent" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm text-white">
                        {s.entry_a_merchant || s.entry_a_description}
                      </div>
                      {s.entry_b_description && (
                        <div className="text-sm text-slate-400">
                          ↔ {s.entry_b_merchant || s.entry_b_description}
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{formatDate(s.entry_a_date)}</span>
                        <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                          {Math.round(s.confidence * 100)}% match
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleConfirm(s.id)}
                      className="p-2 rounded-lg text-emerald-400 hover:bg-emerald-400/10 transition-colors"
                      title="Confirm transfer"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={() => handleDismiss(s.id)}
                      className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                      title="Dismiss"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Uncategorized transactions */}
      {hasUncategorized && (
        <div>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Uncategorized ({uncategorized.length})
          </h2>
          <div className="card divide-y divide-border">
            {uncategorized.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
                    <AlertCircle size={14} className="text-warning" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">
                      {entry.merchant_name || entry.description}
                    </div>
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <span>{formatDate(entry.date)}</span>
                      {entry.plaid_category && (
                        <span className="text-slate-600">{entry.plaid_category}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-sm tabular-nums text-slate-400">
                  {formatCurrency(Math.abs(Number(entry.amount)))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
