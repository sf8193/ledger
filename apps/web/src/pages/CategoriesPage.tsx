import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryError, ListSkeleton } from '../components/QueryState';

interface Category {
  id: string;
  name: string;
  account_type: 'expense' | 'income';
  icon: string | null;
  color: string | null;
  sort_order: number;
}

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [isIncome, setIsIncome] = useState(false);

  const { data: categories, isLoading, isError, error, refetch } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  const expenses = categories?.filter(c => c.account_type === 'expense') || [];
  const income = categories?.filter(c => c.account_type === 'income') || [];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-36 bg-surface rounded animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ListSkeleton rows={4} />
          <ListSkeleton rows={3} />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Categories</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load categories'} onRetry={() => refetch()} />
      </div>
    );
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/categories', {
      method: 'POST',
      body: JSON.stringify({ name, is_income: isIncome }),
    });
    toast.success('Category created');
    setShowAdd(false);
    setName('');
    queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const handleDelete = async (id: string, categoryName: string) => {
    if (!confirm(`Delete "${categoryName}"? Transactions using this category will become uncategorized.`)) return;
    try {
      await apiFetch(`/categories/${id}`, { method: 'DELETE' });
      toast.success('Category deleted');
      queryClient.invalidateQueries({ queryKey: ['categories'] });
    } catch {
      toast.error('Cannot delete — category has transactions');
    }
  };

  function CategorySection({ title, items }: { title: string; items: Category[] }) {
    return (
      <div>
        <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">{title}</h3>
        {items.length > 0 ? (
          <div className="card divide-y divide-border">
            {items.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color || (cat.account_type === 'income' ? '#34d399' : '#94a3b8') }} />
                  <span className="text-sm text-white">{cat.name}</span>
                </div>
                <button
                  onClick={() => handleDelete(cat.id, cat.name)}
                  className="p-1.5 rounded text-slate-600 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="card px-4 py-6 text-center text-sm text-slate-500">
            No {title.toLowerCase()} categories yet
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Categories</h1>
          <p className="text-sm text-slate-500 mt-1">Organize your transactions</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-sm hover:bg-primary/20 transition-colors"
        >
          <Plus size={16} />
          Add
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="card p-4 space-y-3 animate-fade-in">
          <div className="flex gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Category name"
              className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-white text-sm"
              required
              autoFocus
            />
            <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={isIncome}
                onChange={(e) => setIsIncome(e.target.checked)}
                className="rounded"
              />
              Income
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-1.5 rounded-lg bg-primary text-white text-sm">Create</button>
            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-1.5 rounded-lg text-slate-400 text-sm hover:text-white">Cancel</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CategorySection title="Expenses" items={expenses} />
        <CategorySection title="Income" items={income} />
      </div>
    </div>
  );
}
