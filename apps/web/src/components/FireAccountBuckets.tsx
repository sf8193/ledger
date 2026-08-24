import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { isDemoMode } from '../hooks/useDemo';
import { formatCurrency } from '../lib/spending';
import type { AccountBucket } from '../lib/fire/engine';

export interface FireAccount {
  id: string;
  name: string;
  account_type: string;
  balance: number;
  is_hidden: boolean;
  subtype: string | null;
  tax_treatment: string | null;
}

export type BucketType = 'taxable' | 'tax_deferred' | 'roth' | 'skip';

const BUCKET_LABELS: Record<BucketType, { label: string; color: string }> = {
  taxable: { label: 'Taxable', color: 'text-emerald-400' },
  tax_deferred: { label: 'Tax-Deferred', color: 'text-amber-400' },
  roth: { label: 'Roth', color: 'text-blue-400' },
  skip: { label: 'Skip', color: 'text-slate-600' },
};

function fmt(n: number): string {
  if (isDemoMode()) return '$••••';
  return formatCurrency(n);
}

function getTaxTreatment(account: FireAccount): BucketType {
  if (account.tax_treatment) return account.tax_treatment as BucketType;
  if (account.account_type === 'liability') return 'skip';
  return 'taxable';
}

export function FireAccountBuckets() {
  const queryClient = useQueryClient();
  const { data: accounts } = useQuery<FireAccount[]>({
    queryKey: ['accounts'],
    queryFn: () => apiFetch('/accounts'),
  });

  const assetAccounts = useMemo(
    () => (accounts || []).filter(a => a.account_type === 'asset' && !a.is_hidden),
    [accounts],
  );

  const bucketTotals = useMemo(() => {
    const totals: Record<BucketType, number> = { taxable: 0, tax_deferred: 0, roth: 0, skip: 0 };
    for (const a of assetAccounts) {
      totals[getTaxTreatment(a)] += a.balance;
    }
    return totals;
  }, [assetAccounts]);

  const updateTaxTreatment = async (accountId: string, type: BucketType) => {
    await apiFetch(`/accounts/${accountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tax_treatment: type === 'skip' ? null : type }),
    });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  if (!accounts || assetAccounts.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-sm font-medium text-white mb-2">Account Buckets</h3>
        <p className="text-xs text-slate-600">No asset accounts found.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-medium text-white mb-3">Tax Treatment</h3>
      <p className="text-xs text-slate-600 mb-3">
        Withdrawal order: taxable → tax-deferred → Roth. Saved on the account.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {(['taxable', 'tax_deferred', 'roth'] as BucketType[]).map(type => (
          <div key={type} className="bg-surface-lighter rounded-lg px-2.5 py-2 text-center">
            <p className={`text-[11px] ${BUCKET_LABELS[type].color}`}>{BUCKET_LABELS[type].label}</p>
            <p className="text-sm font-medium text-white mt-0.5">{fmt(bucketTotals[type])}</p>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        {assetAccounts.map(account => {
          const type = getTaxTreatment(account);
          return (
            <div key={account.id} className="flex items-center gap-2 bg-surface-lighter rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white truncate">{isDemoMode() ? 'Account ••••' : account.name}</p>
                <p className="text-[11px] text-slate-500">{fmt(account.balance)}</p>
              </div>
              <select
                value={type}
                onChange={e => updateTaxTreatment(account.id, e.target.value as BucketType)}
                className={`bg-transparent text-xs focus:outline-none ${BUCKET_LABELS[type].color}`}
                aria-label={`Tax treatment for ${account.name}`}
              >
                {Object.entries(BUCKET_LABELS).map(([value, { label }]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Build AccountBucket[] from accounts with tax_treatment
export function buildAccountBuckets(
  accounts: FireAccount[],
  defaultReturn: number,
): AccountBucket[] {
  return accounts
    .filter(a => a.account_type === 'asset' && !a.is_hidden)
    .map(a => ({
      id: a.id,
      name: a.name,
      balance: a.balance,
      type: (a.tax_treatment || 'taxable') as AccountBucket['type'],
      annualReturn: defaultReturn,
    }));
}
