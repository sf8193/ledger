import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';
import { X, ChevronDown, Search, Eye } from 'lucide-react';

interface Category {
  id: string;
  name: string;
  account_type: string;
}

export interface ExistingRule {
  id: string;
  match_field: string;
  match_type: string;
  match_value: string;
  target_account_id: string | null;
  rename_merchant: string | null;
  set_owner: string | null;
  set_exclude: boolean | null;
}

interface RuleBuilderProps {
  onClose: () => void;
  /** Pre-fill from a transaction */
  prefill?: {
    entryId?: string;
    merchantName?: string | null;
    description?: string;
    isExpense?: boolean;
  };
  /** Edit an existing rule */
  existingRule?: ExistingRule;
}

type MatchField = 'merchant_name' | 'description';
type MatchType = 'contains' | 'equals' | 'starts_with';

export function RuleBuilderModal({ onClose, prefill, existingRule }: RuleBuilderProps) {
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const isEdit = !!existingRule;

  // Match conditions
  const [matchField, setMatchField] = useState<MatchField>(
    (existingRule?.match_field as MatchField) || 'merchant_name'
  );
  const [matchType, setMatchType] = useState<MatchType>(
    (existingRule?.match_type as MatchType) || 'contains'
  );
  const [matchValue, setMatchValue] = useState(
    existingRule?.match_value || prefill?.merchantName || prefill?.description || ''
  );

  // Actions
  const [targetAccountId, setTargetAccountId] = useState(existingRule?.target_account_id || '');
  const [renameMerchant, setRenameMerchant] = useState(existingRule?.rename_merchant || '');
  const [setOwner, setSetOwner] = useState(existingRule?.set_owner || '');
  // Action toggles — which sections are active
  const [categoryEnabled, setCategoryEnabled] = useState(
    existingRule ? !!existingRule.target_account_id : true
  );
  const [renameEnabled, setRenameEnabled] = useState(!!existingRule?.rename_merchant);
  const [ownerEnabled, setOwnerEnabled] = useState(!!existingRule?.set_owner);
  const [excludeEnabled, setExcludeEnabled] = useState(!!existingRule?.set_exclude);

  // Preview
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Category dropdown
  const [catDropdownOpen, setCatDropdownOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const catRef = useRef<HTMLDivElement>(null);

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/categories'),
  });

  const { data: owners } = useQuery<string[]>({
    queryKey: ['transaction-owners'],
    queryFn: () => apiFetch('/transactions/owners'),
  });

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

  const handleClose = () => {
    setClosing(true);
    setTimeout(onClose, 300);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const relevantCategories = (categories || []).filter((c) =>
    c.account_type === 'expense' || c.account_type === 'income'
  );
  const filteredCategories = catSearch
    ? relevantCategories.filter((c) => c.name.toLowerCase().includes(catSearch.toLowerCase()))
    : relevantCategories;
  const selectedCategoryName = relevantCategories.find((c) => c.id === targetAccountId)?.name;

  const hasAction = (categoryEnabled && targetAccountId) || (renameEnabled && renameMerchant.trim()) || (ownerEnabled && setOwner) || excludeEnabled;
  const canSubmit = matchValue.trim() && hasAction;

  // Preview — debounced
  const fetchPreview = useCallback(async () => {
    if (!matchValue.trim()) { setPreviewCount(null); return; }
    setPreviewing(true);
    try {
      const result = await apiFetch<{ count: number }>('/matching/rules/preview', {
        method: 'POST',
        body: JSON.stringify({ match_field: matchField, match_type: matchType, match_value: matchValue.trim() }),
      });
      setPreviewCount(result.count);
    } catch {
      setPreviewCount(null);
    } finally {
      setPreviewing(false);
    }
  }, [matchField, matchType, matchValue]);

  useEffect(() => {
    const timer = setTimeout(fetchPreview, 400);
    return () => clearTimeout(timer);
  }, [fetchPreview]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        match_field: matchField,
        match_type: matchType,
        match_value: matchValue.trim(),
      };
      if (categoryEnabled && targetAccountId) body.target_account_id = targetAccountId;
      else if (isEdit) body.target_account_id = null;
      if (renameEnabled && renameMerchant.trim()) body.rename_merchant = renameMerchant.trim();
      else if (isEdit) body.rename_merchant = null;
      if (ownerEnabled && setOwner) body.set_owner = setOwner;
      else if (isEdit) body.set_owner = null;
      if (excludeEnabled) body.set_exclude = true;
      else if (isEdit) body.set_exclude = null;

      const url = isEdit ? `/matching/rules/${existingRule!.id}` : '/matching/rules';
      const result = await apiFetch<{ applied?: number; apply_error?: string }>(url, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      if (result.apply_error) {
        toast.warning(`Rule ${isEdit ? 'updated' : 'created'}, but failed to apply to existing transactions`);
      } else if (result.applied && result.applied > 0) {
        toast.success(`Rule ${isEdit ? 'updated' : 'created'} · ${result.applied} existing transactions updated`);
      } else {
        toast.success(`Rule ${isEdit ? 'updated' : 'created'}`);
      }

      queryClient.invalidateQueries({ queryKey: ['rules'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['uncategorized'] });
      handleClose();
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.toLowerCase().includes('duplicate')) {
        toast.error('A rule with this match already exists');
      } else {
        toast.error(msg || 'Failed to create rule');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${closing ? 'animate-backdrop-out' : 'animate-backdrop-in'}`}>
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      <div className={`relative w-full max-w-lg mx-4 bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh] ${closing ? 'opacity-0' : 'animate-fade-in'} transition-opacity duration-200`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-medium text-white">{isEdit ? 'Edit rule' : 'Create rule'}</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

          {/* Section: IF */}
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">If the transaction matches…</div>

            {/* Match field + type */}
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <select
                value={matchField}
                onChange={(e) => setMatchField(e.target.value as MatchField)}
                className="px-2.5 py-2 rounded-lg bg-surface-lighter border border-border text-white text-xs"
              >
                <option value="merchant_name">Merchant name</option>
                <option value="description">Original statement</option>
              </select>
              <select
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as MatchType)}
                className="px-2.5 py-2 rounded-lg bg-surface-lighter border border-border text-white text-xs"
              >
                <option value="contains">contains</option>
                <option value="equals">exactly matches</option>
                <option value="starts_with">starts with</option>
              </select>
            </div>

            <input
              type="text"
              value={matchValue}
              onChange={(e) => setMatchValue(e.target.value)}
              placeholder="e.g. Starbucks"
              className="w-full px-3 py-2.5 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600"
              autoFocus
            />

            {/* Preview count */}
            {matchValue.trim() && (
              <div className="flex items-center gap-1.5 mt-2 text-xs text-slate-500">
                <Eye size={11} />
                {previewing ? (
                  <span>Checking…</span>
                ) : previewCount !== null ? (
                  <span>Matches <span className="text-white font-medium">{previewCount}</span> existing transaction{previewCount !== 1 ? 's' : ''}</span>
                ) : null}
              </div>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Section: THEN */}
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Then apply these updates…</div>
            <div className="space-y-3">

              {/* Update category */}
              <ActionSection
                label="Update category"
                enabled={categoryEnabled}
                onToggle={() => setCategoryEnabled(!categoryEnabled)}
              >
                <div className="relative" ref={catRef}>
                  <button
                    onClick={() => setCatDropdownOpen(!catDropdownOpen)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${
                      targetAccountId
                        ? 'bg-primary/10 border border-primary/30 text-primary'
                        : 'bg-surface-lighter border border-border text-slate-400 hover:text-white'
                    }`}
                  >
                    <span>{selectedCategoryName || 'Select a category…'}</span>
                    <ChevronDown size={14} className={`transition-transform ${catDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {catDropdownOpen && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in">
                      <div className="p-2 border-b border-border">
                        <div className="relative">
                          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
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
                                setTargetAccountId(cat.id);
                                setCatDropdownOpen(false);
                                setCatSearch('');
                              }}
                              className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                                targetAccountId === cat.id
                                  ? 'bg-primary/10 text-primary'
                                  : 'text-slate-300 hover:bg-white/5'
                              }`}
                            >
                              {cat.name}
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-3 text-xs text-slate-500 text-center">No categories match</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </ActionSection>

              {/* Rename merchant */}
              <ActionSection
                label="Rename merchant"
                enabled={renameEnabled}
                onToggle={() => setRenameEnabled(!renameEnabled)}
              >
                <input
                  type="text"
                  value={renameMerchant}
                  onChange={(e) => setRenameMerchant(e.target.value)}
                  placeholder="e.g. Redwood Credit Union"
                  className="w-full px-3 py-2.5 rounded-lg bg-surface-lighter border border-border text-white text-sm placeholder-slate-600"
                />
              </ActionSection>

              {/* Set owner */}
              <ActionSection
                label="Set owner"
                enabled={ownerEnabled}
                onToggle={() => setOwnerEnabled(!ownerEnabled)}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {(owners || []).map((o) => (
                    <button
                      key={o}
                      onClick={() => setSetOwner(setOwner === o ? '' : o)}
                      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                        setOwner === o
                          ? 'bg-primary/15 text-primary border-primary/30'
                          : 'text-slate-500 border-border hover:text-white'
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </ActionSection>

              {/* Hide transaction */}
              <ActionSection
                label="Hide transaction"
                subtitle="Exclude from spending and net worth"
                enabled={excludeEnabled}
                onToggle={() => setExcludeEnabled(!excludeEnabled)}
              />

            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors bg-primary text-white hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save rule' : 'Create rule')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionSection({
  label,
  subtitle,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  subtitle?: string;
  enabled: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border transition-colors ${enabled ? 'border-border bg-surface-lighter/50' : 'border-transparent'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left"
      >
        <div>
          <div className={`text-sm transition-colors ${enabled ? 'text-white' : 'text-slate-500'}`}>{label}</div>
          {subtitle && <div className="text-xs text-slate-600 mt-0.5">{subtitle}</div>}
        </div>
        <div className={`relative w-8 h-[18px] rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-surface-lighter border border-border'}`}>
          <div className={`absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
        </div>
      </button>
      {enabled && children && (
        <div className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
