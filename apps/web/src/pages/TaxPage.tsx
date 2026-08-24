import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { computeTax, computeMarginalRates, estimateW2Withholding, reverseNetToGross, defaultInputs, type TaxInputs, type QuarterlyAmount, type TradingAccount } from '../lib/tax/engine';
import { Plus, Trash2, Save, ChevronDown } from 'lucide-react';

// --- Formatting ---

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function fmtDec(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- Number input ---

function NumInput({ value, onChange, label, className = '' }: {
  value: number; onChange: (v: number) => void; label?: string; className?: string;
}) {
  return (
    <div className={className}>
      {label && <label className="block text-[11px] text-slate-500 mb-0.5">{label}</label>}
      <input
        type="number"
        value={value || ''}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-surface-lighter border border-border rounded px-2 py-1 text-sm text-white tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}

function TextInput({ value, onChange, label, className = '' }: {
  value: string; onChange: (v: string) => void; label?: string; className?: string;
}) {
  return (
    <div className={className}>
      {label && <label className="block text-[11px] text-slate-500 mb-0.5">{label}</label>}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-surface-lighter border border-border rounded px-2 py-1 text-sm text-white"
      />
    </div>
  );
}

// --- Quarterly row ---

function QuarterlyRow({ label, q, onChange }: {
  label: string;
  q: QuarterlyAmount;
  onChange: (q: QuarterlyAmount) => void;
}) {
  const total = q.q1 + q.q2 + q.q3 + q.q4;
  return (
    <div className="grid grid-cols-[1fr_repeat(4,80px)_80px] gap-2 items-end">
      <span className="text-sm text-slate-300 truncate">{label}</span>
      <NumInput value={q.q1} onChange={v => onChange({ ...q, q1: v })} label="Q1" />
      <NumInput value={q.q2} onChange={v => onChange({ ...q, q2: v })} label="Q2" />
      <NumInput value={q.q3} onChange={v => onChange({ ...q, q3: v })} label="Q3" />
      <NumInput value={q.q4} onChange={v => onChange({ ...q, q4: v })} label="Q4" />
      <div>
        <label className="block text-[11px] text-slate-500 mb-0.5">Total</label>
        <div className="text-sm text-slate-400 tabular-nums py-1">{fmt(total)}</div>
      </div>
    </div>
  );
}

// --- Section ---

function Section({ title, children, defaultOpen = true }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-white hover:bg-white/[0.02] transition-colors"
      >
        {title}
        <ChevronDown size={16} className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

// --- Main page ---

interface Scenario {
  id: string;
  tax_year: number;
  name: string;
  inputs: TaxInputs;
  created_at: string;
  updated_at: string;
}

export function TaxPage() {
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();

  const { data: scenarios, isLoading } = useQuery<Scenario[]>({
    queryKey: ['tax-scenarios'],
    queryFn: () => apiFetch('/taxes/scenarios'),
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<TaxInputs>(() => defaultInputs(currentYear));
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // When scenarios load, select the first one or create mode
  useEffect(() => {
    if (scenarios && scenarios.length > 0 && !activeId) {
      const s = scenarios[0];
      setActiveId(s.id);
      setInputs(mergeInputs(s.inputs));
    }
  }, [scenarios, activeId]);

  // Deep merge saved inputs with defaults (survives schema evolution)
  function mergeInputs(saved: any): TaxInputs {
    const d = defaultInputs(saved?.taxYear ?? currentYear);
    const merged = { ...d } as any;
    for (const key of Object.keys(d)) {
      if (saved?.[key] === undefined) continue;
      const dv = (d as any)[key];
      const sv = saved[key];
      // For arrays of objects (w2Income, tradingAccounts), merge per-element
      if (Array.isArray(dv) && Array.isArray(sv) && dv.length > 0 && typeof dv[0] === 'object') {
        merged[key] = sv.map((item: any, i: number) =>
          i < dv.length ? { ...dv[i], ...item } : item
        );
      } else {
        merged[key] = sv;
      }
    }
    return merged;
  }

  const result = useMemo(() => computeTax(inputs), [inputs]);
  const marginalRates = useMemo(() => computeMarginalRates(result), [result]);

  const updateInputs = useCallback((partial: Partial<TaxInputs>) => {
    setInputs(prev => ({ ...prev, ...partial }));
    setDirty(true);
  }, []);

  // Auto-save after 2s of inactivity
  useEffect(() => {
    if (!dirty || !activeId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      apiFetch(`/taxes/scenarios/${activeId}`, {
        method: 'PUT',
        body: JSON.stringify({ tax_year: inputs.taxYear, name: inputs.taxYear.toString(), inputs }),
      }).then(() => {
        setDirty(false);
        queryClient.invalidateQueries({ queryKey: ['tax-scenarios'] });
      }).catch(() => {});
    }, 2000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dirty, activeId, inputs, queryClient]);

  const createScenario = async () => {
    const year = inputs.taxYear;
    const res = await apiFetch<Scenario>('/taxes/scenarios', {
      method: 'POST',
      body: JSON.stringify({ tax_year: year, name: year.toString(), inputs: defaultInputs(year) }),
    });
    setActiveId(res.id);
    setInputs(defaultInputs(year));
    setDirty(false);
    queryClient.invalidateQueries({ queryKey: ['tax-scenarios'] });
  };

  const deleteScenario = async () => {
    if (!activeId) return;
    await apiFetch(`/taxes/scenarios/${activeId}`, { method: 'DELETE' });
    setActiveId(null);
    queryClient.invalidateQueries({ queryKey: ['tax-scenarios'] });
  };

  const forceSave = async () => {
    if (!activeId) return;
    await apiFetch(`/taxes/scenarios/${activeId}`, {
      method: 'PUT',
      body: JSON.stringify({ tax_year: inputs.taxYear, name: inputs.taxYear.toString(), inputs }),
    });
    setDirty(false);
    queryClient.invalidateQueries({ queryKey: ['tax-scenarios'] });
  };

  // --- Trading account helpers ---
  const addTradingAccount = () => {
    updateInputs({
      tradingAccounts: [...inputs.tradingAccounts, { name: `Account ${inputs.tradingAccounts.length + 1}`, q1: 0, q2: 0, q3: 0, q4: 0 }],
    });
  };

  const updateTradingAccount = (idx: number, partial: Partial<TradingAccount>) => {
    const updated = [...inputs.tradingAccounts];
    updated[idx] = { ...updated[idx], ...partial };
    updateInputs({ tradingAccounts: updated });
  };

  const removeTradingAccount = (idx: number) => {
    updateInputs({ tradingAccounts: inputs.tradingAccounts.filter((_, i) => i !== idx) });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Tax Estimation</h1>
          <select
            value={inputs.taxYear}
            onChange={e => updateInputs({ taxYear: parseInt(e.target.value) })}
            className="bg-surface-lighter border border-border rounded px-2 py-1 text-sm text-white"
          >
            {Array.from({ length: 6 }, (_, i) => currentYear - 2 + i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <span className="text-sm text-slate-500">MFJ · Federal + CA</span>
        </div>
        <div className="flex items-center gap-2">
          {scenarios && scenarios.length > 1 && (
            <select
              value={activeId || ''}
              onChange={e => {
                const s = scenarios.find(s => s.id === e.target.value);
                if (s) { setActiveId(s.id); setInputs(mergeInputs(s.inputs)); setDirty(false); }
              }}
              className="bg-surface-lighter border border-border rounded px-2 py-1.5 text-sm text-white"
            >
              {scenarios.map(s => (
                <option key={s.id} value={s.id}>{s.tax_year} — {s.name}</option>
              ))}
            </select>
          )}
          {dirty && (
            <button onClick={forceSave} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors">
              <Save size={14} /> Save
            </button>
          )}
          <button onClick={createScenario} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-slate-300 hover:bg-white/10 transition-colors">
            <Plus size={14} /> New Year
          </button>
          {activeId && (
            <button onClick={deleteScenario} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-slate-400 hover:bg-red-500/15 hover:text-red-400 transition-colors">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ===== ANSWERS FIRST ===== */}

      {/* Deduction recommendation */}
      <div className={`rounded-lg px-4 py-2.5 text-sm border ${
        result.itemizedIsBetter
          ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
          : 'bg-amber-500/5 border-amber-500/20 text-amber-400'
      }`}>
        {result.itemizedIsBetter
          ? `Itemize — saves ${fmt(result.deductionSavings)} vs standard deduction (${fmt(result.standardDeduction)})`
          : `Take standard deduction (${fmt(result.standardDeduction)}) — saves ${fmt(result.deductionSavings)} vs itemizing`
        }
      </div>

      {/* Payment action banner */}
      {result.totalIncome > 0 && (
        <div className={`rounded-lg px-4 py-3 text-sm font-medium border ${
          result.paymentPlan.nextAction.includes('on track')
            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
        }`}>
          {result.paymentPlan.nextAction}
        </div>
      )}

      {/* Key numbers */}
      <div className="bg-surface border border-border rounded-xl p-4 space-y-2 text-sm">
        <Row label="Total Income" value={fmt(result.totalIncome)} />
        <Row label="Total Tax (Federal + CA)" value={fmt(result.totalTaxOwed)}
          bold sub={`${fmtPct(result.totalIncome > 0 ? result.totalTaxOwed / result.totalIncome : 0)} effective`} />
        {result.totalTradingIncome > 0 && (
          <Row label="↳ Trading adds" value={fmt(result.tradingTaxImpact)} color="text-amber-400" />
        )}
        <Divider />
        <Row label="Already paid (withholding + estimated)" value={fmt(result.totalWithholding + result.paymentPlan.totalEstimatedPaid + result.paymentPlan.totalCaEstimatedPaid)} />
        <Row label="Remaining to pay" value={fmtDec(result.totalRemaining)} bold large
          color={result.totalRemaining > 0 ? 'text-red-400' : 'text-emerald-400'} />
      </div>

      {/* ===== INPUTS (below the fold) ===== */}

      {/* W2 Income — compact */}
      <Section title={`W2 Income — ${fmt(result.ordinaryIncome)}`}>
        {inputs.w2Income.map((person, idx) => (
          <div key={idx} className="space-y-2">
            <div className="flex items-end gap-3">
              <TextInput label={`Person ${idx + 1}`} value={person.name}
                onChange={name => {
                  const updated = [...inputs.w2Income] as [typeof person, typeof person];
                  updated[idx] = { ...updated[idx], name };
                  updateInputs({ w2Income: updated });
                }}
                className="w-36"
              />
            </div>
            <QuarterlyRow label={person.name} q={person}
              onChange={q => {
                const updated = [...inputs.w2Income] as [typeof person, typeof person];
                updated[idx] = { ...q, name: person.name };
                updateInputs({ w2Income: updated });
              }}
            />
          </div>
        ))}
      </Section>

      {/* Section 1256 Trading Income */}
      <Section title={`Trading Income (1256) — ${fmt(result.totalTradingIncome)}`} defaultOpen={result.totalTradingIncome > 0}>
        {inputs.tradingAccounts.length === 0 && (
          <p className="text-sm text-slate-500">No trading accounts. Add one if you have Section 1256 income (SPX/NDX/RUT/VIX options, futures).</p>
        )}
        {inputs.tradingAccounts.map((acct, idx) => (
          <div key={idx} className="space-y-2">
            <div className="flex items-end gap-2">
              <TextInput
                label="Account Name"
                value={acct.name}
                onChange={name => updateTradingAccount(idx, { name })}
                className="max-w-[200px]"
              />
              <button
                onClick={() => removeTradingAccount(idx)}
                className="mb-0.5 p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <QuarterlyRow
              label={acct.name}
              q={acct}
              onChange={q => updateTradingAccount(idx, q)}
            />
          </div>
        ))}
        <button
          onClick={addTradingAccount}
          className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
        >
          <Plus size={14} /> Add Trading Account
        </button>
        {inputs.tradingAccounts.length > 0 && (
          <div className="text-sm text-slate-400 pt-1">
            Trading Income Total: <span className="text-white font-medium tabular-nums">{fmt(result.totalTradingIncome)}</span>
          </div>
        )}
      </Section>

      {/* Schedule C */}
      <Section title={`Business Income (Schedule C) — ${fmt(result.scheduleCNet)}`} defaultOpen={false}>
        <p className="text-[11px] text-slate-500 mb-2">LLC / sole proprietorship income. Net profit is subject to self-employment tax. Net loss offsets W2 income.</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <NumInput label="Gross Revenue" value={inputs.scheduleC.grossRevenue}
            onChange={v => updateInputs({ scheduleC: { ...inputs.scheduleC, grossRevenue: v } })} />
          <NumInput label="Business Expenses" value={inputs.scheduleC.expenses}
            onChange={v => updateInputs({ scheduleC: { ...inputs.scheduleC, expenses: v } })} />
          <div>
            <label className="block text-[11px] text-slate-500 mb-0.5">Net Income</label>
            <div className={`text-sm tabular-nums py-1 font-medium ${result.scheduleCNet < 0 ? 'text-red-400' : 'text-white'}`}>
              {fmt(result.scheduleCNet)}
            </div>
          </div>
        </div>
        {result.seTax > 0 && (
          <div className="space-y-1 text-sm pt-2">
            <Row label="Self-Employment Tax" value={fmtDec(result.seTax)} />
            <Row label="Deductible half (above-the-line)" value={`(${fmt(result.seTaxDeduction)})`} color="text-emerald-400" />
          </div>
        )}
        {result.scheduleCNet < 0 && (
          <div className="pt-2 space-y-1.5">
            <p className="text-[11px] text-emerald-400">
              Net loss of {fmt(Math.abs(result.scheduleCNet))} offsets W2 income, saving ~{fmt(Math.abs(result.scheduleCNet) * 0.44)} at your marginal rate.
            </p>
            <p className="text-[11px] text-amber-400/80">
              Hobby loss rule: IRS requires profit motive — 3 profitable years out of 5 to avoid reclassification. Consistent losses may trigger audit scrutiny.
            </p>
          </div>
        )}
      </Section>

      {/* Withholdings */}
      <Section title={`Withholdings & Payments — ${fmt(result.totalWithholding + result.paymentPlan.totalEstimatedPaid + result.paymentPlan.totalCaEstimatedPaid)} paid`}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NumInput label={`${inputs.w2Income[0].name} Federal`} value={inputs.federalWithholding[0]}
            onChange={v => updateInputs({ federalWithholding: [v, inputs.federalWithholding[1]] })} />
          <NumInput label={`${inputs.w2Income[1].name} Federal`} value={inputs.federalWithholding[1]}
            onChange={v => updateInputs({ federalWithholding: [inputs.federalWithholding[0], v] })} />
          <NumInput label={`${inputs.w2Income[0].name} CA`} value={inputs.stateWithholding[0]}
            onChange={v => updateInputs({ stateWithholding: [v, inputs.stateWithholding[1]] })} />
          <NumInput label={`${inputs.w2Income[1].name} CA`} value={inputs.stateWithholding[1]}
            onChange={v => updateInputs({ stateWithholding: [inputs.stateWithholding[0], v] })} />
        </div>
      </Section>

      {/* Deductions */}
      <Section title="Deductions" defaultOpen={false}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NumInput label="Mortgage Balance" value={inputs.mortgageBalance} onChange={v => updateInputs({ mortgageBalance: v })} />
          <NumInput label="Annual Mortgage Interest" value={inputs.annualMortgageInterest} onChange={v => updateInputs({ annualMortgageInterest: v })} />
          <NumInput label="Annual Property Tax" value={inputs.annualPropertyTax} onChange={v => updateInputs({ annualPropertyTax: v })} />
          <NumInput label="Charitable Contributions" value={inputs.charitableContributions} onChange={v => updateInputs({ charitableContributions: v })} />
        </div>
        <div className="space-y-3 text-sm pt-2">
          <div>
            <p className="text-xs text-slate-500 font-medium mb-1">Federal</p>
            <div className="space-y-1">
              <Row label="SALT deduction (prop tax + state income tax, capped)" value={fmt(result.federalSALTDeduction)} />
              <Row label="Mortgage interest (prorated if > $750k)" value={fmt(result.federalMortgageInterest)} />
              <Row label="Total federal deductions" value={fmt(result.totalFederalDeductions)} bold />
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-500 font-medium mb-1">California</p>
            <div className="space-y-1">
              <Row label="CA deductions (no SALT cap, full mortgage)" value={fmt(result.caDeductions)} />
            </div>
          </div>
        </div>
      </Section>

      {/* Estimated Payments */}
      <Section title="Estimated Payments Made" defaultOpen={false}>
        <p className="text-[11px] text-slate-500 mb-2">Enter estimated tax payments you've already sent to the IRS and FTB (not W2 withholding — that's above).</p>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-slate-400 mb-1.5 font-medium">Federal (IRS)</p>
            <div className="grid grid-cols-4 gap-2">
              {(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((q, i) => (
                <NumInput key={q} label={`${q} (by ${['Apr 15', 'Jun 15', 'Sep 15', 'Jan 15'][i]})`}
                  value={inputs.estimatedPayments[i]}
                  onChange={v => {
                    const updated = [...inputs.estimatedPayments] as [number, number, number, number];
                    updated[i] = v;
                    updateInputs({ estimatedPayments: updated });
                  }}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1.5 font-medium">California (FTB)</p>
            <div className="grid grid-cols-4 gap-2">
              {(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((q, i) => (
                <NumInput key={q} label={q}
                  value={inputs.caEstimatedPayments[i]}
                  onChange={v => {
                    const updated = [...inputs.caEstimatedPayments] as [number, number, number, number];
                    updated[i] = v;
                    updateInputs({ caEstimatedPayments: updated });
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Payment Planner */}
      <Section title="Payment Planner — Safe Harbor" defaultOpen={true}>
        <div className="grid grid-cols-2 gap-3 max-w-md mb-3">
          <NumInput label="Prior Year Federal Tax" value={inputs.priorYearFederalTax} onChange={v => updateInputs({ priorYearFederalTax: v })} />
          <NumInput label="Prior Year CA Tax" value={inputs.priorYearCATax} onChange={v => updateInputs({ priorYearCATax: v })} />
        </div>

        {/* Next action banner */}
        <div className={`rounded-lg px-4 py-3 text-sm font-medium mb-3 ${
          result.paymentPlan.nextAction.includes('on track')
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
        }`}>
          {result.paymentPlan.nextAction}
        </div>

        {/* Quarterly table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-slate-500 border-b border-border">
                <th className="text-left py-2 pr-3">Quarter</th>
                <th className="text-left py-2 pr-3">Deadline</th>
                <th className="text-right py-2 pr-3">Fed Required</th>
                <th className="text-right py-2 pr-3">Fed Paid</th>
                <th className="text-right py-2 pr-3">Fed Short</th>
                <th className="text-right py-2 pr-3">CA Required</th>
                <th className="text-right py-2 pr-3">CA Paid</th>
                <th className="text-right py-2">CA Short</th>
              </tr>
            </thead>
            <tbody>
              {result.paymentPlan.quarters.map(q => (
                <tr key={q.quarter} className={`border-b border-border/50 ${q.isPast ? 'text-slate-500' : 'text-white'}`}>
                  <td className="py-2 pr-3 font-medium">{q.quarter}</td>
                  <td className="py-2 pr-3 text-slate-400">{q.deadline}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmt(q.federalRequired)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmt(q.federalPaid)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums font-medium ${q.federalShortfall > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {q.federalShortfall > 0 ? fmt(q.federalShortfall) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmt(q.caRequired)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmt(q.caPaid)}</td>
                  <td className={`py-2 text-right tabular-nums font-medium ${q.caShortfall > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {q.caShortfall > 0 ? fmt(q.caShortfall) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm pt-3">
          <Row label="110% Safe Harbor Target" value={fmt(result.safeHarborTarget)} />
          <Row label="Total Paid (W2 + Estimated)" value={fmt(result.totalWithholding + result.paymentPlan.totalEstimatedPaid + result.paymentPlan.totalCaEstimatedPaid)} />
          <Row label="Shortfall" value={result.safeHarborShortfall > 0 ? fmt(result.safeHarborShortfall) : 'None'}
            bold color={result.safeHarborShortfall > 0 ? 'text-red-400' : 'text-emerald-400'} />
        </div>
      </Section>

      {/* Federal Tax Breakdown */}
      <Section title="Federal Tax Breakdown" defaultOpen={false}>
        <div className="space-y-2 text-sm">
          <Row label="Ordinary Income" value={fmt(result.ordinaryIncome)} />
          <Row label="Less: Federal Deductions" value={`(${fmt(result.totalFederalDeductions)})`} />
          <Row label="Taxable Ordinary Income" value={fmt(result.taxableOrdinaryIncome)} bold />
          <Divider />
          <Row label="Ordinary Income Tax" value={fmtDec(result.federalOrdinaryTax)} sub={`Effective: ${fmtPct(result.federalOrdinaryRate)}`} />
          <Row label="Trading Income Tax (1256)" value={fmtDec(result.federalBusinessTax)} />
          <Row label="NIIT (3.8%)" value={fmtDec(result.federalNIIT)} />
          {result.seTax > 0 && <Row label="Self-Employment Tax" value={fmtDec(result.seTax)} />}
          <Divider />
          <Row label="Total Federal Tax" value={fmtDec(result.federalTotalTax)} bold />
          <Row label="Less: W2 Withholding" value={`(${fmt(result.federalWithholding)})`} />
          <Row
            label="Federal Remaining to Pay"
            value={fmtDec(result.federalRemaining)}
            bold
            color={result.federalRemaining > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
        </div>
      </Section>

      {/* Business Income Detail */}
      {result.totalTradingIncome > 0 && (
        <Section title="Trading Tax — 1256 Bracket Stacking" defaultOpen={false}>
          <div className="space-y-2 text-sm">
            <Row label="Ordinary + ST layer base (deductions + 40% ST)" value={fmt(result.businessDetail.stLayerBase)} />
            <Row label="LT portion (60%)" value={fmt(result.businessDetail.ltPortion)} />
            <Row label="Ordinary marginal rate" value={fmtPct(result.businessDetail.marginalRate)} />
            <Divider />
            <Row label="LT taxed at 0%" value={fmt(result.businessDetail.ltAt0)} />
            <Row label="LT taxed at 15%" value={fmt(result.businessDetail.ltAt15)} />
            <Row label="LT taxed at 20%" value={fmt(result.businessDetail.ltAt20)} />
            <Divider />
            <Row label="Annual Trading Tax (1256)" value={fmtDec(result.federalBusinessTax)} bold />
            <p className="text-[11px] text-slate-500 pt-1">Quarterly allocations are proportional to quarterly income, not independent per-quarter calculations.</p>
            <div className="grid grid-cols-4 gap-2 pt-1">
              {(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((q, i) => (
                <div key={q} className="text-center">
                  <p className="text-[11px] text-slate-500">{q}</p>
                  <p className="text-sm text-white tabular-nums">{fmtDec(result.quarterlyBusinessTax[i])}</p>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* CA Tax */}
      <Section title="California Tax" defaultOpen={false}>
        <div className="space-y-2 text-sm">
          <Row label="CA Taxable Income" value={fmt(result.caTaxableIncome)} />
          <Row label="CA Tax" value={fmtDec(result.caTax)} bold />
          <Row label="Less: CA Withholding" value={`(${fmt(result.caWithholding)})`} />
          <Row
            label="CA Remaining to Pay"
            value={fmtDec(result.caRemaining)}
            bold
            color={result.caRemaining > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
        </div>
      </Section>

      {/* Marginal Rates & Harvesting */}
      <Section title="Marginal Rates & Harvesting" defaultOpen={false}>
        <div className="space-y-2 text-sm">
          <Row label="Federal marginal rate (ordinary)" value={fmtPct(marginalRates.federalMarginalOrdinary)} />
          <Row label="Federal marginal rate (ST cap gains)" value={fmtPct(marginalRates.federalMarginalSTCG)} />
          <Row label="Federal marginal rate (LT cap gains)" value={fmtPct(marginalRates.federalMarginalLTCG)} />
          <Row label="CA marginal rate" value={fmtPct(marginalRates.caMarginalRate)} />
          <Divider />
          <Row label="Combined marginal (ST + CA + NIIT)" value={fmtPct(marginalRates.combinedMarginalST)} bold />
          <Row label="Combined marginal (LT + CA + NIIT)" value={fmtPct(marginalRates.combinedMarginalLT)} bold />
          <Divider />
          <Row
            label="Tax savings per $1,000 harvested (1256 blend)"
            value={fmtDec(marginalRates.harvestingValue)}
            bold
            color="text-emerald-400"
          />
          <p className="text-[11px] text-slate-500 pt-1">
            Harvesting value uses the blended 1256 rate (40% ST + 60% LT) plus CA + NIIT.
            Actual savings depend on your ability to offset gains in the same tax year.
          </p>
        </div>
      </Section>

      {/* Net-to-Gross Calculator */}
      <NetToGrossSection taxYear={inputs.taxYear} />

      {/* Withholding Estimator */}
      <Section title="W2 Withholding Estimator" defaultOpen={false}>
        <p className="text-[11px] text-slate-500 mb-3">
          Estimates annual withholding from gross W2 salary. Cross-check against your YTD paystub numbers.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {inputs.w2Income.map((person, idx) => {
            const salary = person.q1 + person.q2 + person.q3 + person.q4;
            const est = estimateW2Withholding(salary, inputs.taxYear);
            return (
              <div key={idx} className="bg-surface-lighter border border-border rounded-lg p-3 space-y-2">
                <p className="text-sm font-medium text-white">{person.name}</p>
                <p className="text-[11px] text-slate-500">Based on {fmt(salary)} annual gross</p>
                <div className="space-y-1 text-sm">
                  <Row label="Est. Federal Withholding" value={fmt(est.federalWithholding)} />
                  <Row label="Est. CA Withholding" value={fmt(est.caWithholding)} />
                  <Row label="FICA + Medicare" value={fmt(est.ficaMedicare)} />
                  <Divider />
                  <Row label="Total Withholding" value={fmt(est.totalWithholding)} bold />
                  <Row label="Est. Net Pay" value={fmt(est.netPay)} color="text-emerald-400" />
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// --- Net-to-Gross component ---

function NetToGrossSection({ taxYear }: { taxYear: number }) {
  const [netPaycheck, setNetPaycheck] = useState(0);
  const [frequency, setFrequency] = useState(24); // semi-monthly

  const result = useMemo(() => {
    if (netPaycheck <= 0) return null;
    return reverseNetToGross(netPaycheck, frequency, taxYear);
  }, [netPaycheck, frequency, taxYear]);

  return (
    <Section title="Net → Gross Calculator" defaultOpen={false}>
      <p className="text-[11px] text-slate-500 mb-3">
        Enter the net deposit amount from your paycheck (what hits your bank). This reverse-engineers the gross salary and estimated withholding.
        Useful when Plaid only shows post-tax deposits.
      </p>
      <div className="flex items-end gap-3 mb-3">
        <NumInput label="Net per paycheck" value={netPaycheck} onChange={setNetPaycheck} className="w-40" />
        <div>
          <label className="block text-[11px] text-slate-500 mb-0.5">Pay frequency</label>
          <select
            value={frequency}
            onChange={e => setFrequency(parseInt(e.target.value))}
            className="bg-surface-lighter border border-border rounded px-2 py-1 text-sm text-white"
          >
            <option value={52}>Weekly (52)</option>
            <option value={26}>Bi-weekly (26)</option>
            <option value={24}>Semi-monthly (24)</option>
            <option value={12}>Monthly (12)</option>
          </select>
        </div>
      </div>
      {result && (
        <div className="bg-surface-lighter border border-border rounded-lg p-3 space-y-1 text-sm max-w-md">
          <Row label="Annual Net (observed)" value={fmt(result.estimatedAnnualNet)} />
          <Row label="Estimated Annual Gross" value={fmt(result.estimatedAnnualGross)} bold color="text-white" />
          <Divider />
          <Row label="Est. Federal Withholding" value={fmt(result.estimatedFederalWithholding)} />
          <Row label="Est. CA Withholding" value={fmt(result.estimatedCAWithholding)} />
          <Row label="Est. FICA + Medicare" value={fmt(result.estimatedFICA)} />
          <p className="text-[11px] text-slate-500 pt-2">
            Approximation only — actual withholding depends on W-4 elections, pre-tax deductions (401k, HSA, etc.), and employer setup.
          </p>
        </div>
      )}
    </Section>
  );
}

// --- Layout helpers ---

function Row({ label, value, sub, bold, color, large }: {
  label: string; value: string; sub?: string; bold?: boolean; color?: string; large?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between ${large ? 'py-1' : ''}`}>
      <span className={`text-slate-400 ${bold ? 'font-medium text-slate-300' : ''}`}>{label}</span>
      <div className="text-right">
        <span className={`tabular-nums ${bold ? 'font-medium' : ''} ${color || 'text-white'} ${large ? 'text-lg' : ''}`}>{value}</span>
        {sub && <span className="text-[11px] text-slate-500 ml-2">{sub}</span>}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-border my-1" />;
}
