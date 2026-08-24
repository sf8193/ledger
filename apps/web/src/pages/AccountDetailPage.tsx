import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useState, useRef, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Building2, CreditCard, Landmark, Pencil, Check, X, ExternalLink } from 'lucide-react';
import { TransactionDetail } from '../components/TransactionDetail';
import { formatCurrency } from '../lib/spending';
import { isDemoMode, demoText } from '../hooks/useDemo';
import { ownerColorPalette, buildOwnerColors } from '../lib/owners';

interface AccountDetail {
  id: string;
  name: string;
  account_type: string;
  subtype: string | null;
  mask: string | null;
  institution_name: string | null;
  institution_logo: string | null;
  institution_color: string | null;
  balance: number;
  transaction_count: number;
  is_manual: boolean;
  is_hidden: boolean;
  plaid_item_id: string | null;
  last_synced: string | null;
  connection_status: string | null;
  owner: string | null;
  credit_limit: number | null;
  apr_purchase: number | null;
  apr_cash: number | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  minimum_payment: number | null;
  next_payment_due_date: string | null;
  last_statement_balance: number | null;
  is_overdue: boolean | null;
}

interface Transaction {
  id: string;
  date: string;
  description: string;
  merchant_name: string | null;
  owner: string | null;
  notes: string | null;
  is_verified: boolean;
  source: string | null;
  exclude_from_totals?: boolean | null;
  reimbursement_status?: 'pending' | 'reimbursed' | null;
  amount: number;
  lines: Array<{ id: string; journal_entry_id: string; account_id: string; account_name: string; account_type: string; amount: number }>;
  category?: { id: string; journal_entry_id: string; account_id: string; account_name: string; account_type: string; amount: number } | null;
  pending?: boolean;
}

function formatSubtype(subtype: string | null): string {
  if (!subtype) return 'Account';
  return subtype.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseDate(d: string): Date {
  // Handle both "YYYY-MM-DD" and ISO timestamps
  if (d.length === 10) return new Date(d + 'T00:00:00');
  return new Date(d);
}

function formatDate(d: string): string {
  return parseDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<Transaction | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: account, isLoading } = useQuery<AccountDetail>({
    queryKey: ['account', id],
    queryFn: () => apiFetch(`/accounts/${id}`),
    enabled: !!id,
  });

  const { data: txnData } = useQuery<{ data: Transaction[]; pending: Transaction[]; total: number }>({
    queryKey: ['transactions', { account_id: id }],
    queryFn: () => apiFetch(`/transactions?account_id=${id}&limit=50`),
    enabled: !!id,
  });

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

  const ownerOptions = useMemo(() => owners || [], [owners]);
  const ownerColors = useMemo(() => buildOwnerColors(ownerOptions), [ownerOptions]);

  const handleSetOwner = async (newOwner: string | null) => {
    if (!id) return;
    try {
      await apiFetch(`/accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ owner: newOwner }),
      });
      queryClient.invalidateQueries({ queryKey: ['account', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(newOwner ? `Owner set to ${newOwner}` : 'Owner removed');
    } catch {
      toast.error('Failed to update owner');
    }
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (!trimmed || !id) return;
    try {
      await apiFetch(`/accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed }),
      });
      queryClient.invalidateQueries({ queryKey: ['account', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('Account renamed');
    } catch {
      toast.error('Failed to rename');
    }
    setEditing(false);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        <div className="h-64 bg-surface rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-400">Account not found</p>
        <button onClick={() => navigate('/accounts')} className="mt-2 text-sm text-primary hover:underline">
          Back to accounts
        </button>
      </div>
    );
  }

  const absBalance = Math.abs(account.balance);
  const transactions = txnData?.data || [];
  const pendingTxns = txnData?.pending || [];
  const totalTxns = txnData?.total || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/accounts')}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-surface flex items-center justify-center overflow-hidden shrink-0 border border-border">
            {account.institution_logo ? (
              <img
                src={`data:image/${account.institution_logo.startsWith('/9j/') ? 'jpeg' : account.institution_logo.startsWith('PHN2') ? 'svg+xml' : 'png'};base64,${account.institution_logo}`}
                alt="" className="w-full h-full object-cover"
              />
            ) : account.institution_name ? (
              <span className="text-sm font-bold" style={{ color: account.institution_color || '#94a3b8' }}>
                {account.institution_name.charAt(0)}
              </span>
            ) : (
              <Landmark size={16} className="text-slate-500" />
            )}
          </div>
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); handleRename(); }} className="flex items-center gap-2 flex-1">
              <input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
                className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border text-white text-lg font-semibold"
              />
              <button type="submit" className="p-1.5 text-emerald-400 hover:text-emerald-300"><Check size={16} /></button>
              <button type="button" onClick={() => setEditing(false)} className="p-1.5 text-slate-500 hover:text-white"><X size={16} /></button>
            </form>
          ) : (
            <button
              onClick={() => { setEditing(true); setEditName(account.name); }}
              className="flex items-center gap-2 group min-w-0"
            >
              <h1 className="text-xl font-semibold text-white truncate group-hover:text-primary transition-colors">
                {demoText(account.name, 'Account ••••')}
              </h1>
              <Pencil size={12} className="text-slate-600 group-hover:text-primary shrink-0 transition-colors" />
            </button>
          )}
        </div>
      </div>

      {/* Summary Card */}
      <div className="card p-5 space-y-4">
        <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider">Summary</h2>

        <div className="text-center py-2">
          <div className={`text-3xl font-semibold tabular-nums ${account.balance >= 0 ? 'text-white' : 'text-red-400'}`}>
            {formatCurrency(absBalance)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {account.account_type === 'liability' ? 'Current balance' : 'Balance'}
          </div>
        </div>

        <div className="divide-y divide-border">
          <DetailRow icon={<Building2 size={14} />} label="Institution" value={account.institution_name || 'Manual'} valueColor={account.institution_name ? 'text-primary' : undefined} />
          <DetailRow icon={<CreditCard size={14} />} label="Account type" value={formatSubtype(account.subtype)} />
          {account.mask && (
            <DetailRow icon={<span className="text-xs">····</span>} label="Last 4" value={account.mask} />
          )}
          <DetailRow icon={<span className="text-xs font-mono">#</span>} label="Total transactions" value={String(account.transaction_count)} />
          {['asset', 'liability'].includes(account.account_type) && (
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2.5 text-slate-400">
                <span className="w-4 flex justify-center"><span className="text-xs">@</span></span>
                <span className="text-sm">Owner</span>
              </div>
              <div className="flex items-center gap-1.5">
                {ownerOptions.map((o) => {
                  const isActive = account.owner === o;
                  const colors = ownerColors[o] || ownerColorPalette[0];
                  return (
                    <button
                      key={o}
                      onClick={() => handleSetOwner(isActive ? null : o)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${isActive ? colors.active : colors.inactive}`}
                    >
                      {demoText(o)}
                    </button>
                  );
                })}
                {ownerOptions.length === 0 && (
                  <span className="text-xs text-slate-600">No household members</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Credit Card Details */}
      {(account.credit_limit != null || account.apr_purchase != null || account.next_payment_due_date != null) && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider">Credit Details</h2>
            {account.last_synced && (
              <span className="text-[10px] text-slate-600">
                as of {new Date(account.last_synced).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>

          {/* Utilization bar */}
          {account.credit_limit != null && account.credit_limit > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-slate-400">Credit utilization</span>
                <span className="text-sm font-medium text-white">
                  {isDemoMode() ? '••%' : `${Math.round((absBalance / account.credit_limit) * 100)}%`}
                </span>
              </div>
              <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isDemoMode() ? 'bg-primary' :
                    absBalance / account.credit_limit > 0.7 ? 'bg-red-400' :
                    absBalance / account.credit_limit > 0.3 ? 'bg-amber-400' : 'bg-primary'
                  }`}
                  style={{ width: isDemoMode() ? '50%' : `${Math.min(100, (absBalance / account.credit_limit) * 100)}%` }}
                />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-xs text-slate-500">{formatCurrency(absBalance)}</span>
                <span className="text-xs text-slate-500">{formatCurrency(account.credit_limit)}</span>
              </div>
            </div>
          )}

          <div className="divide-y divide-border">
            {account.credit_limit != null && account.credit_limit > 0 && (
              <>
                <DetailRow label="Credit limit" value={formatCurrency(account.credit_limit)} />
                <DetailRow label="Available" value={formatCurrency(account.credit_limit - absBalance)} valueColor="text-emerald-400" />
              </>
            )}
            {account.apr_purchase && (
              <DetailRow label="Purchase APR" value={`${account.apr_purchase}%`} />
            )}
            {account.minimum_payment !== null && account.minimum_payment !== undefined && (
              <DetailRow label="Minimum payment" value={formatCurrency(account.minimum_payment)} />
            )}
            {account.last_payment_amount && account.last_payment_date && (
              <DetailRow label="Last payment" value={`${formatCurrency(account.last_payment_amount)} on ${formatDate(account.last_payment_date)}`} />
            )}
            {account.next_payment_due_date && (
              <DetailRow label="Next due" value={formatDate(account.next_payment_due_date)} />
            )}
            {account.last_statement_balance !== null && account.last_statement_balance !== undefined && (
              <DetailRow label="Last statement" value={formatCurrency(account.last_statement_balance)} />
            )}
            {account.is_overdue && (
              <DetailRow label="Status" value="Overdue" valueColor="text-red-400" />
            )}
          </div>
        </div>
      )}

      {/* Connection Status */}
      {account.plaid_item_id && (
        <div className="card p-5 space-y-3">
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider">Connection</h2>
          <div className="divide-y divide-border">
            <DetailRow
              label="Status"
              value={account.connection_status === 'active' ? 'Connected' : account.connection_status || 'Unknown'}
              valueColor={account.connection_status === 'active' ? 'text-emerald-400' : 'text-red-400'}
            />
            <DetailRow
              label="Last synced"
              value={account.last_synced ? new Date(account.last_synced).toLocaleString() : 'Never'}
            />
          </div>
        </div>
      )}

      {/* Recent Transactions */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between">
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider">Recent Transactions</h2>
          {totalTxns > 50 && (
            <Link
              to={`/transactions?account_id=${id}`}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View all {totalTxns} <ExternalLink size={10} />
            </Link>
          )}
        </div>

        {pendingTxns.length > 0 && (
          <div className="px-5 pb-1">
            <div className="text-[10px] text-amber-400/70 uppercase tracking-wider font-medium mb-1">Pending</div>
          </div>
        )}
        {pendingTxns.map(txn => (
          <TxnRow key={txn.id} txn={txn} accountId={id} pending />
        ))}

        {transactions.length > 0 ? (
          transactions.map(txn => (
            <TxnRow key={txn.id} txn={txn} accountId={id} onClick={() => setSelectedEntry(txn)} />
          ))
        ) : pendingTxns.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No transactions yet
          </div>
        ) : null}
      </div>

      {selectedEntry && (
        <TransactionDetail
          key={selectedEntry.id}
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}

function DetailRow({ icon, label, value, valueColor }: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-2.5 text-slate-400">
        {icon && <span className="w-4 flex justify-center">{icon}</span>}
        <span className="text-sm">{label}</span>
      </div>
      <span className={`text-sm font-medium ${valueColor || 'text-white'}`}>{value}</span>
    </div>
  );
}

function TxnRow({ txn, accountId, pending, onClick }: { txn: Transaction; accountId?: string; pending?: boolean; onClick?: () => void }) {
  const category = txn.category?.account_name;
  // When viewing from a specific account, show the amount from that account's perspective
  const accountLine = accountId ? txn.lines?.find(l => l.account_id === accountId) : null;
  const displayAmount = accountLine ? Number(accountLine.amount) : txn.amount;
  return (
    <div className={`flex items-center justify-between px-5 py-3 border-t border-border hover:bg-white/[0.02] transition-colors ${pending ? 'opacity-60' : ''} ${onClick ? 'cursor-pointer' : ''}`} onClick={onClick}>
      <div className="min-w-0">
        <div className="text-sm text-white truncate">{txn.merchant_name || txn.description}</div>
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          <span>{formatDate(txn.date)}</span>
          {category && <><span className="text-slate-600">·</span><span>{category}</span></>}
          {pending && <><span className="text-slate-600">·</span><span className="text-amber-400/70">Pending</span></>}
        </div>
      </div>
      <div className={`text-sm font-medium tabular-nums shrink-0 ml-3 ${displayAmount > 0 ? 'text-emerald-400' : 'text-white'}`}>
        {displayAmount > 0 ? '+' : ''}{formatCurrency(Math.abs(displayAmount))}
      </div>
    </div>
  );
}
