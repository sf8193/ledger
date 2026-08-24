import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Wand2, Trash2, Plus, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryError, ListSkeleton } from '../components/QueryState';
import { RuleBuilderModal } from '../components/RuleBuilderModal';

interface Rule {
  id: string;
  match_field: string;
  match_type: string;
  match_value: string;
  priority: number;
  target_account_id: string | null;
  target_account_name: string | null;
  target_account_type: string | null;
  rename_merchant: string | null;
  set_owner: string | null;
  set_exclude: boolean | null;
}

function matchTypeLabel(type: string): string {
  switch (type) {
    case 'contains': return 'contains';
    case 'equals': return 'equals';
    case 'starts_with': return 'starts with';
    default: return type;
  }
}

function matchFieldLabel(field: string): string {
  switch (field) {
    case 'merchant_name': return 'Merchant';
    case 'description': return 'Description';
    default: return field;
  }
}

export function RulesPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const { data: rules, isLoading, isError, error, refetch } = useQuery<Rule[]>({
    queryKey: ['rules'],
    queryFn: () => apiFetch('/matching/rules'),
  });

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/matching/rules/${id}`, { method: 'DELETE' });
      toast.success('Rule deleted');
      queryClient.invalidateQueries({ queryKey: ['rules'] });
    } catch (err) {
      toast.error((err as Error).message || 'Failed to delete rule');
    } finally {
      setDeleting(null);
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
        <h1 className="text-2xl font-semibold text-white">Rules</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load rules'} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Rules</h1>
          <p className="text-sm text-slate-500 mt-1">
            Auto-categorize transactions by merchant or description
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          <Plus size={14} />
          New rule
        </button>
      </div>

      {showCreate && (
        <RuleBuilderModal
          onClose={() => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: ['rules'] });
          }}
        />
      )}

      {editingRule && (
        <RuleBuilderModal
          existingRule={editingRule}
          onClose={() => {
            setEditingRule(null);
            queryClient.invalidateQueries({ queryKey: ['rules'] });
          }}
        />
      )}

      {rules && rules.length > 0 ? (
        <div className="card divide-y divide-border">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between px-4 py-3 group">
              <div className="min-w-0">
                <div className="text-sm text-white">
                  <span className="text-slate-500">{matchFieldLabel(rule.match_field)}</span>
                  {' '}
                  <span className="text-slate-400">{matchTypeLabel(rule.match_type)}</span>
                  {' '}
                  <span className="font-medium">"{rule.match_value}"</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <Wand2 size={10} />
                  {rule.target_account_name && (
                    <span>→ {rule.target_account_name}</span>
                  )}
                  {rule.rename_merchant && (
                    <span className="text-slate-400">· rename → "{rule.rename_merchant}"</span>
                  )}
                  {rule.set_owner && (
                    <span className="text-slate-400">· owner → {rule.set_owner}</span>
                  )}
                  {rule.set_exclude && (
                    <span className="text-slate-400">· hide</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => setEditingRule(rule)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:text-white hover:bg-white/5 transition-colors"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => handleDelete(rule.id)}
                  disabled={deleting === rule.id}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card px-5 py-12 text-center">
          <Wand2 size={28} className="text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-white">No rules yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Create rules to auto-categorize incoming transactions
          </p>
        </div>
      )}
    </div>
  );
}

