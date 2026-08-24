import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Plus, Wallet, Eye, EyeOff, ChevronDown, ChevronUp, Building2, CreditCard, TrendingUp, Landmark, Link2 } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { QueryError, ListSkeleton } from '../components/QueryState';
import { PlaidLinkButton } from '../components/PlaidLink';
import { formatCurrency } from '../lib/spending';
import { ownerColorPalette, buildOwnerColors } from '../lib/owners';
import { demoText, isDemoMode } from '../hooks/useDemo';

interface Account {
  id: string;
  name: string;
  account_type: string;
  balance: number;
  is_manual: boolean;
  is_hidden: boolean;
  institution_name: string | null;
  institution_logo: string | null;
  institution_color: string | null;
  mask: string | null;
  subtype: string | null;
  owner: string | null;
}

const typeConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  asset: { label: 'Assets', icon: Building2, color: 'text-emerald-400' },
  liability: { label: 'Liabilities', icon: CreditCard, color: 'text-red-400' },
  investment: { label: 'Investments', icon: TrendingUp, color: 'text-blue-400' },
};

export function AccountsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState<'manual' | 'plaid' | false>(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('asset');
  const [balance, setBalance] = useState('');

  const { data: accounts, isLoading, isError, error, refetch } = useQuery<Account[]>({
    queryKey: ['accounts'],
    queryFn: () => apiFetch('/accounts'),
  });

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

  const ownerOptions = useMemo(() => owners || [], [owners]);
  const ownerColors = useMemo(() => buildOwnerColors(ownerOptions), [ownerOptions]);

  const handleSetOwner = async (accountId: string, currentOwner: string | null, newOwner: string) => {
    const resolvedOwner = currentOwner === newOwner ? null : newOwner;

    // Optimistic update to prevent hover flicker during bulk assignment
    queryClient.setQueryData<Account[]>(['accounts'], (old) =>
      old?.map(a => a.id === accountId ? { ...a, owner: resolvedOwner } : a)
    );

    try {
      await apiFetch(`/accounts/${accountId}`, {
        method: 'PUT',
        body: JSON.stringify({ owner: resolvedOwner }),
      });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      toast.success(resolvedOwner ? `Owner set to ${resolvedOwner}` : 'Owner removed');
    } catch {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.error('Failed to update owner');
    }
  };

  // Filter to asset/liability only (skip expense/income/equity)
  const bankAccounts = accounts?.filter(a => ['asset', 'liability'].includes(a.account_type)) || [];
  const visibleAccounts = bankAccounts.filter(a => !a.is_hidden);
  const hiddenAccounts = bankAccounts.filter(a => a.is_hidden);

  // Group by type
  const grouped = visibleAccounts.reduce((acc, a) => {
    const key = a.account_type;
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {} as Record<string, Account[]>);

  const totalNetWorth = visibleAccounts.reduce((sum, a) => sum + a.balance, 0);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name,
        account_type: type,
        initial_balance: parseFloat(balance) || 0,
      }),
    });
    toast.success('Account added');
    setShowAdd(false as const);
    setName('');
    setBalance('');
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const toggleHidden = async (accountId: string, currentlyHidden: boolean) => {
    await apiFetch(`/accounts/${accountId}`, {
      method: 'PUT',
      body: JSON.stringify({ is_hidden: !currentlyHidden }),
    });
    toast.success(currentlyHidden ? 'Account shown' : 'Account hidden');
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-36 bg-surface rounded animate-pulse" />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Accounts</h1>
        <QueryError message={(error as Error)?.message || 'Failed to load accounts'} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-white">Accounts</h1>
          <div className="relative">
            <button
              onClick={() => setShowAddMenu(!showAddMenu)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
              title="Add account"
            >
              <Plus size={16} />
            </button>
          {showAddMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
              <div className="absolute left-0 mt-1 w-48 rounded-lg bg-surface border border-border shadow-lg z-20 overflow-hidden">
                <button
                  onClick={() => { setShowAdd('plaid'); setShowAddMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
                >
                  <Link2 size={14} className="text-primary" />
                  Connect a Bank
                </button>
                <button
                  onClick={() => { setShowAdd('manual'); setShowAddMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
                >
                  <Wallet size={14} className="text-slate-400" />
                  Manual Account
                </button>
              </div>
            </>
          )}
          </div>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          Net worth: <span className={`font-medium ${totalNetWorth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {formatCurrency(totalNetWorth)}
          </span>
        </p>
      </div>

      {showAdd === 'plaid' && (
        <div className="card p-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-400">Link your bank accounts via Plaid</p>
            <button onClick={() => setShowAdd(false)} className="text-xs text-slate-500 hover:text-white">Cancel</button>
          </div>
          <div className="mt-3">
            <PlaidLinkButton onSuccess={() => {
              setShowAdd(false);
              queryClient.invalidateQueries({ queryKey: ['accounts'] });
              queryClient.invalidateQueries({ queryKey: ['dashboard'] });
            }} />
          </div>
        </div>
      )}

      {showAdd === 'manual' && (
        <form onSubmit={handleAdd} className="card p-4 space-y-3 animate-fade-in">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Main Checking"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-white text-sm"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-white text-sm"
              >
                <option value="asset">Asset (Checking, Savings, Brokerage)</option>
                <option value="liability">Liability (Credit Card, Loan)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Balance</label>
              <input
                type="number"
                step="0.01"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-white text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-1.5 rounded-lg bg-primary text-white text-sm">Save</button>
            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-1.5 rounded-lg text-slate-400 text-sm hover:text-white transition-colors">Cancel</button>
          </div>
        </form>
      )}

      {/* Grouped accounts */}
      {Object.entries(grouped).map(([accountType, accts]) => {
        const config = typeConfig[accountType] || { label: accountType, icon: Wallet, color: 'text-slate-400' };
        const Icon = config.icon;
        const groupTotal = accts.reduce((sum, a) => sum + a.balance, 0);

        return (
          <div key={accountType}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Icon size={14} className={config.color} />
                <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider">{config.label}</h3>
              </div>
              <span className={`text-xs tabular-nums ${config.color}`}>{formatCurrency(groupTotal)}</span>
            </div>
            <div className="card divide-y divide-border">
              {accts.map((account) => (
                <div key={account.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors group cursor-pointer" onClick={() => navigate(`/accounts/${account.id}`)}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-surface-lighter flex items-center justify-center overflow-hidden shrink-0">
                      {account.institution_logo ? (
                        <img src={`data:image/${account.institution_logo.startsWith('/9j/') ? 'jpeg' : account.institution_logo.startsWith('PHN2') ? 'svg+xml' : 'png'};base64,${account.institution_logo}`} alt="" className="w-full h-full object-cover" />
                      ) : account.institution_name ? (
                        <span
                          className="text-xs font-bold"
                          style={{ color: account.institution_color || '#94a3b8' }}
                        >
                          {account.institution_name.charAt(0)}
                        </span>
                      ) : (
                        <Landmark size={14} className="text-slate-500" />
                      )}
                    </div>
                    <div>
                      <div className="text-sm text-white">{demoText(account.name, 'Account ••••')}</div>
                      <div className="text-xs text-slate-500">
                        {demoText(account.institution_name || (account.is_manual ? 'Manual' : account.subtype || ''), '••••')}
                        {!isDemoMode() && account.mask && ` ····${account.mask}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      {ownerOptions.map((o) => {
                        const isActive = account.owner === o;
                        const colors = ownerColors[o] || ownerColorPalette[0];
                        return (
                          <button
                            key={o}
                            onClick={(e) => { e.stopPropagation(); handleSetOwner(account.id, account.owner, o); }}
                            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors ${isActive ? colors.active : colors.inactive}`}
                          >
                            {demoText(o)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-sm font-medium text-white tabular-nums">
                      {formatCurrency(account.balance)}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleHidden(account.id, account.is_hidden); }}
                      className="p-1.5 rounded text-slate-600 hover:text-white hover:bg-surface-lighter opacity-0 group-hover:opacity-100 transition-all"
                      title={account.is_hidden ? 'Show in net worth' : 'Hide from net worth'}
                    >
                      {account.is_hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {visibleAccounts.length === 0 && hiddenAccounts.length === 0 && (
        <div className="card px-5 py-12 text-center">
          <Wallet size={28} className="text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-white">No accounts yet</p>
          <p className="text-xs text-slate-500 mt-1">Add a manual account or connect a bank</p>
        </div>
      )}

      {hiddenAccounts.length > 0 && (
        <div>
          <button
            onClick={() => setShowHidden(!showHidden)}
            className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showHidden ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {hiddenAccounts.length} hidden
          </button>
          {showHidden && (
            <div className="card divide-y divide-border mt-2">
              {hiddenAccounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between px-4 py-3 opacity-50 group hover:opacity-75 transition-opacity">
                  <div className="text-sm text-white">{demoText(account.name, 'Account ••••')}</div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums text-slate-400">{formatCurrency(account.balance)}</span>
                    <button
                      onClick={() => toggleHidden(account.id, true)}
                      className="p-1.5 rounded text-slate-600 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <EyeOff size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
