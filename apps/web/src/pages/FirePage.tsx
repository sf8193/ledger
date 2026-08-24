import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { isDemoMode } from '../hooks/useDemo';
import { formatCurrency } from '../lib/spending';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, ReferenceDot,
} from 'recharts';
import { FireTimeline } from '../components/FireTimeline';
import { FireAccountBuckets, buildAccountBuckets, type FireAccount } from '../components/FireAccountBuckets';
import {
  computeProjection, computeDrawdownYears, computeCoastNumber,
  computeBaristaContribution, computeSSBenefit, estimatePIA,
  type FireInputs, type ProjectionPoint, type TimelineEvent,
  type SocialSecurityInputs, type ReturnPhase,
} from '../lib/fire/engine';

// --- Persistence ---
// Settings are cached in localStorage for instant load, then synced to server

const STORAGE_KEY = 'fire-calculator-settings';

function loadSettings(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function saveSettingsLocal(settings: Record<string, any>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function usePersisted<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = loadSettings();
    return (saved[key] as T) ?? defaultValue;
  });
  useEffect(() => {
    const current = loadSettings();
    current[key] = value;
    saveSettingsLocal(current);
  }, [key, value]);
  return [value, setValue];
}

// Hydrate localStorage from server on first load (cross-device sync)
function useServerHydration() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const local = loadSettings();
    // Only hydrate if localStorage is empty (fresh device)
    if (Object.keys(local).length > 0) {
      setHydrated(true);
      return;
    }
    apiFetch('/fire/settings')
      .then((serverSettings: any) => {
        if (serverSettings && Object.keys(serverSettings).length > 0) {
          saveSettingsLocal(serverSettings);
          window.location.reload(); // reload to pick up hydrated values in usePersisted
        }
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, []);
  return hydrated;
}

// Debounced sync of all settings to server
function useSettingsSync() {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const settings = loadSettings();
      apiFetch('/fire/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }).catch(() => {}); // silent fail — localStorage is the primary store
    }, 2000);
  }, []);
}

// --- Scenarios (server-backed) ---

interface Scenario {
  id: string;
  name: string;
  inputs: Record<string, any>;
  created_at: string;
}

// --- API types ---

interface DashboardData {
  netWorth: number;
  monthlySpending: number;
  monthlyIncome: number;
}

interface CashFlowData {
  data: Array<{ month: string; income: number; expenses: number }>;
  totalIncome: number;
  totalExpenses: number;
}

// --- Formatting ---

function fmt(n: number): string {
  if (isDemoMode()) return '$••••';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return formatCurrency(n);
}

function fmtAxis(n: number): string {
  if (isDemoMode()) return '$••';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n}`;
}

// --- Input component ---

let inputIdCounter = 0;

function NumberInput({ label, value, onChange, prefix, suffix, step, min, max, help, isCurrency }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
  isCurrency?: boolean;
}) {
  const [id] = useState(() => `fire-input-${++inputIdCounter}`);
  const helpId = help ? `${id}-help` : undefined;
  const demo = isDemoMode() && isCurrency;
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-slate-400 mb-1">{label}</label>
      <div className="flex items-center gap-1">
        {prefix && <span className="text-sm text-slate-500" aria-hidden="true">{prefix}</span>}
        {demo ? (
          <span className="w-full bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-sm text-slate-500">••••••</span>
        ) : (
          <input
            id={id}
            type="number"
            value={value}
            onChange={e => {
              const raw = e.target.value;
              if (raw === '') return; // don't force 0 on clear
              onChange(Number(raw));
            }}
            onFocus={e => e.target.select()}
            step={step ?? 1}
            min={min}
            max={max}
            aria-describedby={helpId}
            className="w-full bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-primary/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        )}
        {suffix && <span className="text-sm text-slate-500" aria-hidden="true">{suffix}</span>}
      </div>
      {help && <p id={helpId} className="text-[11px] text-slate-600 mt-0.5">{help}</p>}
    </div>
  );
}

// --- Tooltip ---

function CustomTooltip({ active, payload, label, simMode }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload as (ProjectionPoint & { comparePortfolio?: number }) | undefined;
  if (!data) return null;
  const isHist = simMode === 'historical';
  return (
    <div className="bg-surface-lighter border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-slate-400 mb-1.5">Age {label} ({data.year})</p>
      <p className="flex justify-between gap-4">
        <span className="text-slate-400">Portfolio:</span>
        <span className="text-white font-medium">{fmt(data.portfolio)}</span>
      </p>
      {data.comparePortfolio !== undefined && (
        <p className="flex justify-between gap-4">
          <span className="text-amber-400/70">Comparison:</span>
          <span className="text-amber-400 font-medium">{fmt(data.comparePortfolio)}</span>
        </p>
      )}
      <div className="mt-1 pt-1 border-t border-white/5">
        <p className="flex justify-between gap-4">
          <span className="text-red-400/70">Worst 10%:</span>
          <span className="text-slate-300">{fmt(isHist ? data.hp10 : data.p10)}</span>
        </p>
        <p className="flex justify-between gap-4">
          <span className="text-slate-500">Best 10%:</span>
          <span className="text-slate-300">{fmt(isHist ? data.hp90 : data.p90)}</span>
        </p>
      </div>
    </div>
  );
}

// --- Social Security panel ---

function SocialSecurityPanel({ ss, onChange, annualIncome }: {
  ss: SocialSecurityInputs;
  onChange: (ss: SocialSecurityInputs) => void;
  annualIncome: number;
}) {
  const estimatedPIA = estimatePIA(annualIncome);
  const benefit62 = computeSSBenefit(ss.monthlyBenefitAt67, 62);
  const benefit67 = ss.monthlyBenefitAt67;
  const benefit70 = computeSSBenefit(ss.monthlyBenefitAt67, 70);

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Social Security</h3>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={ss.enabled}
            onChange={e => onChange({ ...ss, enabled: e.target.checked })}
            className="rounded border-border bg-surface-lighter"
          />
          Include
        </label>
      </div>

      {!ss.enabled && (
        <p className="text-xs text-slate-600 mt-2">Enable to model SS benefits reducing retirement spending needs.</p>
      )}

      {ss.enabled && (
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Monthly benefit at 67 (PIA)</label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-slate-500" aria-hidden="true">$</span>
              {isDemoMode() ? (
                <span className="w-full bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-sm text-slate-500">••••••</span>
              ) : (
                <input
                  type="number"
                  value={ss.monthlyBenefitAt67}
                  onChange={e => onChange({ ...ss, monthlyBenefitAt67: Number(e.target.value) })}
                  step={100}
                  min={0}
                  className="w-full bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-primary/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              )}
            </div>
            <button
              onClick={() => onChange({ ...ss, monthlyBenefitAt67: estimatedPIA })}
              className="text-[11px] text-primary hover:text-primary/80 mt-1"
            >
              Estimate from income (~{isDemoMode() ? '$••••' : `$${estimatedPIA}`}/mo)
            </button>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Claiming age</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={62}
                max={70}
                value={ss.claimingAge}
                onChange={e => onChange({ ...ss, claimingAge: Number(e.target.value) })}
                className="flex-1 accent-primary"
              />
              <span className="text-sm text-white w-6 text-right">{ss.claimingAge}</span>
            </div>
          </div>

          {/* Claiming age comparison */}
          <div className="grid grid-cols-3 gap-1 text-center">
            {[
              { age: 62, benefit: benefit62, label: 'Age 62' },
              { age: 67, benefit: benefit67, label: 'Age 67' },
              { age: 70, benefit: benefit70, label: 'Age 70' },
            ].map(({ age, benefit, label }) => (
              <button
                key={age}
                onClick={() => onChange({ ...ss, claimingAge: age })}
                className={`rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  ss.claimingAge === age
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-lighter text-slate-400 hover:text-white'
                }`}
              >
                <div className="font-medium">{label}</div>
                <div className="text-[10px] mt-0.5">{isDemoMode() ? '$••••' : `$${Math.round(benefit)}`}/mo</div>
                <div className="text-[10px]">{isDemoMode() ? '$••••' : `$${Math.round(benefit * 12).toLocaleString()}`}/yr</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main page ---

type SimMode = 'montecarlo' | 'historical';

export function FirePage() {
  const { data: dashboard, isLoading: dashLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => apiFetch('/dashboard'),
  });

  const { data: cashflow, isLoading: cfLoading } = useQuery<CashFlowData>({
    queryKey: ['cashflow', 12, null],
    queryFn: () => apiFetch('/dashboard/cashflow?months=12'),
  });

  const { data: accounts } = useQuery<FireAccount[]>({
    queryKey: ['accounts'],
    queryFn: () => apiFetch('/accounts'),
  });

  const settingsHydrated = useServerHydration();
  const isLoading = dashLoading || cfLoading || !settingsHydrated;

  // Persisted inputs
  const [currentAge, setCurrentAge] = usePersisted('currentAge', 33);
  const [retirementAge, setRetirementAge] = usePersisted('retirementAge', 55);
  const [nominalReturn, setNominalReturn] = usePersisted('nominalReturn', 8);
  const [inflation, setInflation] = usePersisted('inflation', 3);
  const [swr, setSwr] = usePersisted('swr', 4);
  const [stockAllocation, setStockAllocation] = usePersisted('stockAllocation', 80);
  const [taxAwareWithdrawals, setTaxAwareWithdrawals] = usePersisted('taxAwareWithdrawals', true);
  const [timelineEvents, setTimelineEvents] = usePersisted<TimelineEvent[]>('timelineEvents', []);
  const [returnPhases, setReturnPhases] = usePersisted<ReturnPhase[]>('returnPhases', []);
  const [socialSecurity, setSocialSecurity] = usePersisted<SocialSecurityInputs>('socialSecurity', {
    enabled: false,
    monthlyBenefitAt67: 2500,
    claimingAge: 67,
  });

  // Sync settings to server (debounced)
  const syncSettings = useSettingsSync();
  useEffect(() => {
    syncSettings();
  }, [currentAge, retirementAge, nominalReturn, inflation, swr, stockAllocation, timelineEvents, socialSecurity, returnPhases, taxAwareWithdrawals, syncSettings]);

  // Session-only overrides (reset to ledger on each visit)
  const [overridePortfolio, setOverridePortfolio] = useState<number | null>(null);
  const [overrideIncome, setOverrideIncome] = useState<number | null>(null);
  const [overrideSpending, setOverrideSpending] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [simMode, setSimMode] = useState<SimMode>('historical');
  const queryClient = useQueryClient();
  const { data: scenarios = [] } = useQuery<Scenario[]>({
    queryKey: ['fire-scenarios'],
    queryFn: () => apiFetch('/fire/scenarios'),
  });
  const [compareId, setCompareId] = useState<string | null>(null);
  const [scenarioName, setScenarioName] = useState('');

  const saveCurrentAsScenario = async () => {
    if (!scenarioName.trim()) return;
    await apiFetch('/fire/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: scenarioName.trim(),
        inputs: {
          currentAge, retirementAge, nominalReturn, inflation, swr, stockAllocation,
          overridePortfolio, overrideIncome, overrideSpending,
          timelineEvents, socialSecurity, returnPhases,
          // Snapshot current financial state for accurate comparisons
          snapshotPortfolio: currentPortfolio,
          snapshotIncome: annualIncome,
          snapshotSpending: annualSpending,
        },
      }),
    });
    queryClient.invalidateQueries({ queryKey: ['fire-scenarios'] });
    setScenarioName('');
  };

  const loadScenario = (scenario: Scenario) => {
    const s = scenario.inputs;
    setCurrentAge(s.currentAge);
    setRetirementAge(s.retirementAge);
    setNominalReturn(s.nominalReturn);
    setInflation(s.inflation);
    setSwr(s.swr);
    setStockAllocation(s.stockAllocation);
    setOverridePortfolio(s.overridePortfolio ?? null);
    setOverrideIncome(s.overrideIncome ?? null);
    setOverrideSpending(s.overrideSpending ?? null);
    setTimelineEvents(s.timelineEvents ?? []);
    setSocialSecurity(s.socialSecurity ?? { enabled: false, monthlyBenefitAt67: 2500, claimingAge: 67 });
    setReturnPhases(s.returnPhases ?? []);
  };

  const deleteScenario = async (id: string) => {
    await apiFetch(`/fire/scenarios/${id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: ['fire-scenarios'] });
    if (compareId === id) setCompareId(null);
  };

  // Compute comparison scenario projection
  const compareResult = useMemo(() => {
    if (!compareId) return null;
    const sc = scenarios.find(s => s.id === compareId);
    if (!sc) return null;
    const s = sc.inputs;
    // Use snapshot values if available (saved at scenario creation time), otherwise fall back to current
    const cPortfolio = s.snapshotPortfolio ?? s.overridePortfolio ?? (dashboard?.netWorth ?? 0);
    const cIncome = s.snapshotIncome ?? s.overrideIncome ?? annualIncome;
    const cSpending = s.snapshotSpending ?? s.overrideSpending ?? annualSpending;
    const cContribution = Math.max(cIncome - cSpending, 0);
    const cBuckets = accounts ? buildAccountBuckets(accounts, (1 + s.nominalReturn / 100) / (1 + s.inflation / 100) - 1) : null;
    return computeProjection({
      currentAge: s.currentAge, retirementAge: s.retirementAge,
      currentPortfolio: cPortfolio, annualContribution: cContribution,
      nominalReturn: s.nominalReturn, inflation: s.inflation,
      annualSpending: cSpending, swr: s.swr,
      timelineEvents: s.timelineEvents, accountBuckets: cBuckets,
      stockAllocation: s.stockAllocation, socialSecurity: s.socialSecurity,
      returnPhases: s.returnPhases ?? [], taxAwareWithdrawals: true,
    });
  }, [compareId, scenarios, dashboard, cashflow, accounts]);

  // Derive values from ledger
  const currentPortfolio = overridePortfolio ?? (dashboard?.netWorth ?? 0);
  const cashflowMonths = cashflow?.data?.length ?? 0;
  const annualIncome = overrideIncome ?? (cashflowMonths > 0
    ? (cashflow!.totalIncome / cashflowMonths) * 12
    : (dashboard?.monthlyIncome ?? 0) * 12);
  const annualSpending = overrideSpending ?? (cashflowMonths > 0
    ? (cashflow!.totalExpenses / cashflowMonths) * 12
    : (dashboard?.monthlySpending ?? 0) > 0 ? (dashboard!.monthlySpending * 12) : 60000);
  const annualContribution = Math.max(annualIncome - annualSpending, 0);
  const savingsRate = annualIncome > 0 ? (annualContribution / annualIncome) * 100 : 0;

  // Build account buckets from mapping
  const realReturnDecimal = (1 + nominalReturn / 100) / (1 + inflation / 100) - 1;
  const engineBuckets = useMemo(
    () => accounts ? buildAccountBuckets(accounts, realReturnDecimal) : null,
    [accounts, realReturnDecimal],
  );

  // Run projection engine
  const inputs: FireInputs = useMemo(() => ({
    currentAge, retirementAge, currentPortfolio, annualContribution,
    nominalReturn, inflation, annualSpending, swr,
    timelineEvents, accountBuckets: engineBuckets, stockAllocation, socialSecurity,
    returnPhases, taxAwareWithdrawals,
  }), [currentAge, retirementAge, currentPortfolio, annualContribution,
    nominalReturn, inflation, annualSpending, swr, timelineEvents, engineBuckets, stockAllocation, socialSecurity, returnPhases, taxAwareWithdrawals]);

  const result = useMemo(() => computeProjection(inputs), [inputs]);
  const { points: rawPoints, fireAge, fireNumber, leanNumber, fatNumber, mcFireYears, historicalSuccessRate, historicalFireYears } = result;

  const compareScenario = compareId ? scenarios.find(s => s.id === compareId) : null;
  const points = rawPoints; // use rawPoints for computations, chartData for rendering

  const yearsToFire = fireAge !== null ? fireAge - currentAge : null;
  const realReturn = ((1 + nominalReturn / 100) / (1 + inflation / 100) - 1) * 100;
  // Defensive clamp: persisted retirementAge may be stale if currentAge was updated
  const effectiveRetirementAge = Math.max(retirementAge, currentAge + 1);
  const yearsToRetirement = effectiveRetirementAge - currentAge;
  const coastNumber = computeCoastNumber(fireNumber, realReturn, yearsToRetirement);
  const isCoastFire = currentPortfolio >= coastNumber;
  const baristaContribution = computeBaristaContribution(fireNumber, currentPortfolio, yearsToRetirement, realReturn);
  const drawdownPortfolio = points.find(p => p.age === retirementAge)?.portfolio ?? currentPortfolio;
  const drawdownYears = computeDrawdownYears(drawdownPortfolio, annualSpending, realReturn);

  // Chart data keys based on sim mode
  const fireYearsData = simMode === 'historical' ? historicalFireYears : mcFireYears;

  // Clamp chart data to prevent extreme p90 outliers from crushing the projection
  const { chartData, chartYMax } = useMemo(() => {
    // Focus chart on accumulation → early retirement (not 60 years out)
    const chartEndAge = Math.min(effectiveRetirementAge + 15, Math.max(...rawPoints.map(p => p.age)));
    const sliced = rawPoints.filter(p => p.age <= chartEndAge);

    const maxPortfolio = Math.max(...sliced.map(p => p.portfolio));
    const yMax = Math.max(maxPortfolio, fireNumber) * 1.15;

    const chartPoints = compareResult ? sliced.map((p) => ({
      ...p,
      comparePortfolio: compareResult.points.find(cp => cp.age === p.age)?.portfolio ?? 0,
    })) : sliced;

    return { chartData: chartPoints, chartYMax: yMax };
  }, [rawPoints, fireNumber, compareResult, effectiveRetirementAge]);

  if (isLoading) {
    return (
      <div>
        <h1 className="text-lg font-semibold text-white mb-1">FIRE Calculator</h1>
        <p className="text-sm text-slate-500 mb-5">Loading your financial data...</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-3 animate-pulse">
              <div className="h-3 w-16 bg-white/5 rounded mb-2" />
              <div className="h-6 w-20 bg-white/5 rounded mb-1" />
              <div className="h-3 w-24 bg-white/5 rounded" />
            </div>
          ))}
        </div>
        <div className="bg-surface border border-border rounded-xl p-4 animate-pulse h-[400px]" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-lg font-semibold text-white mb-1">FIRE Calculator</h1>
      <p className="text-sm text-slate-500 mb-4">Financial Independence, Retire Early — projection based on your ledger data</p>

      {/* Scenarios bar */}
      <div className="bg-surface border border-border rounded-xl px-4 py-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-slate-500 shrink-0">Scenarios:</span>
          {scenarios.map(sc => (
            <div key={sc.id} className="flex items-center gap-1">
              <button
                onClick={() => loadScenario(sc)}
                className="text-xs px-2 py-1 rounded bg-surface-lighter hover:bg-white/5 text-slate-300 hover:text-white transition-colors"
                title={`Load "${sc.name}"`}
              >
                {sc.name}
              </button>
              <button
                onClick={() => setCompareId(compareId === sc.id ? null : sc.id)}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  compareId === sc.id ? 'bg-amber-400/15 text-amber-400' : 'text-slate-600 hover:text-slate-400'
                }`}
                title={compareId === sc.id ? 'Stop comparing' : `Compare with "${sc.name}"`}
              >
                {compareId === sc.id ? 'vs' : 'cmp'}
              </button>
              <button
                onClick={() => deleteScenario(sc.id)}
                className="text-[10px] text-slate-700 hover:text-red-400 transition-colors"
                title={`Delete "${sc.name}"`}
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1 ml-auto">
            <input
              type="text"
              value={scenarioName}
              onChange={e => setScenarioName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveCurrentAsScenario()}
              placeholder="Scenario name"
              className="bg-surface-lighter border border-border rounded px-2 py-1 text-xs text-white w-32 focus:outline-none focus:border-primary/50"
            />
            <button
              onClick={saveCurrentAsScenario}
              disabled={!scenarioName.trim()}
              className="text-xs px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-30"
            >
              Save
            </button>
          </div>
        </div>
        {compareScenario && (
          <p className="text-[11px] text-amber-400 mt-2">
            Comparing current inputs vs "{compareScenario.name}" (dashed amber line on chart)
          </p>
        )}
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="FIRE Number" value={fmt(fireNumber)} sub={`${swr}% SWR`} />
        <StatCard
          label="Years to FIRE"
          value={yearsToFire !== null ? `${yearsToFire}` : 'N/A'}
          sub={fireYearsData ? `p50: ${fireYearsData.p50.toFixed(0)}yr (${fireYearsData.p10.toFixed(0)}–${fireYearsData.p90.toFixed(0)})` : fireAge !== null ? `Age ${fireAge}` : 'Increase savings'}
          highlight={yearsToFire !== null && yearsToFire <= 10}
        />
        <StatCard label="Savings Rate" value={`${savingsRate.toFixed(0)}%`} sub={`${fmt(annualContribution)}/yr`} />
        <StatCard label="Coast FIRE" value={isCoastFire ? 'Reached' : fmt(coastNumber)} sub={isCoastFire ? 'No contributions needed' : `Need ${fmt(coastNumber)}`} highlight={isCoastFire} />
        <StatCard
          label="Historical Success"
          value={`${(historicalSuccessRate * 100).toFixed(0)}%`}
          sub={`of ${Math.floor(REAL_STOCK_RETURNS_LENGTH - (retirementAge - currentAge + 30))} periods survived`}
          highlight={historicalSuccessRate >= 0.95}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart */}
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-white">Portfolio Projection</h2>
            <div className="flex items-center gap-2">
              {(['historical', 'montecarlo'] as SimMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSimMode(mode)}
                  className={`text-[11px] px-2 py-1 rounded transition-colors ${
                    simMode === mode ? 'bg-primary/15 text-primary' : 'text-slate-600 hover:text-slate-400'
                  }`}
                >
                  {mode === 'historical' ? 'Historical' : 'Monte Carlo'}
                </button>
              ))}
            </div>
          </div>
          <div
            className="h-[360px] overflow-hidden"
            role="img"
            aria-label={`FIRE projection chart from age ${currentAge} to retirement at ${retirementAge}. Current portfolio ${fmt(currentPortfolio)}, FIRE target ${fmt(fireNumber)}.${fireAge !== null ? ` FI at age ${fireAge}.` : ''} Historical success rate ${(historicalSuccessRate * 100).toFixed(0)}%.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }} accessibilityLayer>
                <defs>
                  <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="age"
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={{ stroke: '#1e293b' }}
                  tickLine={false}
                  label={{ value: 'Age', position: 'insideBottom', offset: -2, fill: '#475569', fontSize: 11 }}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={fmtAxis}
                  width={55}
                  domain={[0, chartYMax]}
                  allowDataOverflow={true}
                />
                <Tooltip content={<CustomTooltip simMode={simMode} />} />
                {fireAge !== null && (
                  <ReferenceLine
                    x={fireAge}
                    stroke="#f59e0b"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{ value: `FI @ ${fireAge}`, fill: '#f59e0b', fontSize: 10, position: 'top' }}
                  />
                )}
                <ReferenceLine
                  x={retirementAge}
                  stroke="#64748b"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  label={{ value: 'Retire', fill: '#64748b', fontSize: 10, position: 'top' }}
                />
                {/* Timeline event markers */}
                {timelineEvents.map(evt => (
                  <ReferenceLine
                    key={evt.id}
                    x={evt.age}
                    stroke="#8b5cf6"
                    strokeDasharray="2 4"
                    strokeWidth={1}
                    label={{ value: evt.label, fill: '#8b5cf6', fontSize: 9, position: 'top' }}
                  />
                ))}
                {/* "You are here" */}
                <ReferenceDot x={currentAge} y={currentPortfolio} r={5} fill="#10b981" stroke="white" strokeWidth={1.5} />
                {/* Percentile edge lines — p10 (worst 10%) and p90 (best 10%) */}
                <Area type="monotone" dataKey={simMode === 'historical' ? 'hp90' : 'p90'} name="Best 10%" stroke="#64748b" strokeWidth={1} strokeDasharray="4 3" fill="none" legendType="none" />
                <Area type="monotone" dataKey={simMode === 'historical' ? 'hp10' : 'p10'} name="Worst 10%" stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" fill="none" legendType="none" />
                {/* Deterministic line */}
                <Area
                  type="monotone"
                  dataKey="portfolio"
                  name="Portfolio"
                  stroke="#10b981"
                  strokeWidth={3}
                  fill="url(#portfolioGrad)"
                />
                {/* Comparison scenario line */}
                {compareResult && (
                  <Area
                    type="monotone"
                    dataKey="comparePortfolio"
                    name={compareScenario?.name || 'Comparison'}
                    stroke="#f59e0b"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    fill="none"
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="w-4 h-0.5 bg-emerald-500 rounded" /> Your projection
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="w-4 h-0 border-t border-dashed border-red-400" /> Worst 10% of outcomes
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="w-4 h-0 border-t border-dashed border-slate-500" /> Best 10% of outcomes
            </span>
            <span className="text-[11px] text-slate-600 ml-auto">
              {simMode === 'historical'
                ? `${stockAllocation}/${100 - stockAllocation} stocks/bonds · ${(historicalSuccessRate * 100).toFixed(0)}% success`
                : '1,000 MC trials · 15% stdev'
              }
            </span>
          </div>
        </div>

        {/* Inputs panel */}
        <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-medium text-white">Assumptions</h2>

          <div className="grid grid-cols-2 gap-3">
            <NumberInput label="Current Age" value={currentAge} onChange={setCurrentAge} min={18} max={80} />
            <NumberInput label="Retirement Age" value={retirementAge} onChange={setRetirementAge} min={currentAge + 1} max={100} />
          </div>

          <NumberInput
            label="Current Portfolio"
            value={currentPortfolio}
            onChange={v => setOverridePortfolio(v)}
            prefix="$"
            step={10000}
            isCurrency
            help={overridePortfolio === null && dashboard ? 'From your ledger net worth' : undefined}
          />
          <NumberInput
            label="Annual Income"
            value={annualIncome}
            onChange={v => setOverrideIncome(v)}
            prefix="$"
            step={5000}
            isCurrency
            help={overrideIncome === null && (cashflow || dashboard) ? 'From your ledger data' : undefined}
          />
          <NumberInput
            label="Annual Spending"
            value={annualSpending}
            onChange={v => setOverrideSpending(v)}
            prefix="$"
            step={5000}
            isCurrency
            help={overrideSpending === null && (cashflow || dashboard) ? 'From your ledger data' : undefined}
          />
          <NumberInput label={returnPhases.length > 0 ? "Default Return" : "Expected Return"} value={nominalReturn} onChange={setNominalReturn} suffix="%" step={0.5} min={0} max={20} />

          {/* Return Phases */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-slate-400">Return Phases</label>
              <button
                onClick={() => setReturnPhases([...returnPhases, {
                  id: crypto.randomUUID(),
                  fromAge: returnPhases.length > 0
                    ? Math.min(returnPhases[returnPhases.length - 1].fromAge + 10, 80)
                    : retirementAge,
                  nominalReturn: nominalReturn > 2 ? nominalReturn - 2 : nominalReturn,
                }])}
                className="text-xs text-primary hover:text-primary/80 transition-colors"
              >
                + Add phase
              </button>
            </div>
            {returnPhases.length > 0 && (
              <div className="space-y-2">
                {returnPhases
                  .sort((a, b) => a.fromAge - b.fromAge)
                  .map((phase) => (
                  <div key={phase.id} className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 whitespace-nowrap">Age</span>
                    <input
                      type="number"
                      value={phase.fromAge}
                      onChange={e => setReturnPhases(returnPhases.map(p =>
                        p.id === phase.id ? { ...p, fromAge: Number(e.target.value) } : p
                      ))}
                      className="w-14 bg-surface border border-border rounded px-1.5 py-1 text-sm text-white text-center tabular-nums"
                      min={currentAge}
                      max={90}
                    />
                    <span className="text-xs text-slate-500">→</span>
                    <input
                      type="number"
                      value={phase.nominalReturn}
                      onChange={e => setReturnPhases(returnPhases.map(p =>
                        p.id === phase.id ? { ...p, nominalReturn: Number(e.target.value) } : p
                      ))}
                      step={0.5}
                      className="w-16 bg-surface border border-border rounded px-1.5 py-1 text-sm text-white text-center tabular-nums"
                      min={0}
                      max={20}
                    />
                    <span className="text-xs text-slate-500">%</span>
                    <button
                      onClick={() => setReturnPhases(returnPhases.filter(p => p.id !== phase.id))}
                      className="text-slate-600 hover:text-red-400 transition-colors text-xs ml-auto"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <p className="text-[11px] text-slate-600">
                  {nominalReturn}% until age {returnPhases.sort((a, b) => a.fromAge - b.fromAge)[0]?.fromAge}
                  {returnPhases.sort((a, b) => a.fromAge - b.fromAge).map((p, i, arr) =>
                    `, then ${p.nominalReturn}%${i < arr.length - 1 ? ` until ${arr[i + 1].fromAge}` : ''}`
                  ).join('')}
                </p>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-primary hover:text-primary/80 transition-colors"
          >
            {showAdvanced ? 'Hide' : 'Show'} advanced
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-1 border-t border-border">
              <NumberInput label="Inflation" value={inflation} onChange={setInflation} suffix="%" step={0.5} min={0} max={15} />
              <NumberInput label="Safe Withdrawal Rate" value={swr} onChange={setSwr} suffix="%" step={0.25} min={1} max={10} />
              <div>
                <label className="block text-xs text-slate-400 mb-1">Stock Allocation (historical sim)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={stockAllocation}
                    onChange={e => setStockAllocation(Number(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <span className="text-sm text-white w-10 text-right">{stockAllocation}%</span>
                </div>
                <p className="text-[11px] text-slate-600 mt-0.5">{stockAllocation}% stocks / {100 - stockAllocation}% bonds</p>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-500">
                  Real return: {realReturn.toFixed(1)}%
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={taxAwareWithdrawals}
                    onChange={e => setTaxAwareWithdrawals(e.target.checked)}
                    className="accent-primary"
                  />
                  <span className="text-xs text-slate-400">Tax-aware withdrawals</span>
                </label>
              </div>
            </div>
          )}

          {(overridePortfolio !== null || overrideIncome !== null || overrideSpending !== null) && (
            <button
              onClick={() => { setOverridePortfolio(null); setOverrideIncome(null); setOverrideSpending(null); }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Reset to ledger values
            </button>
          )}
        </div>
      </div>

      {/* Timeline events + Social Security + Account Buckets */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
        <FireTimeline events={timelineEvents} onChange={setTimelineEvents} currentAge={currentAge} />
        <SocialSecurityPanel ss={socialSecurity} onChange={setSocialSecurity} annualIncome={annualIncome} />
        <FireAccountBuckets />
      </div>

      {/* FIRE milestones */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
        <MilestoneCard title="Lean FIRE" target={leanNumber} spending={annualSpending * 0.7} current={currentPortfolio} description="70% of current spending" color="text-green-400" />
        <MilestoneCard title="Regular FIRE" target={fireNumber} spending={annualSpending} current={currentPortfolio} description="Maintain current spending" color="text-amber-400" />
        <MilestoneCard title="Fat FIRE" target={fatNumber} spending={annualSpending * 1.5} current={currentPortfolio} description="150% of current spending" color="text-red-400" />
      </div>

      {/* Barista + Drawdown */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-white mb-2">Barista FIRE</h3>
          <p className="text-xs text-slate-400 mb-2">
            Part-time income needed to reach FIRE by age {retirementAge}, on top of investment growth.
          </p>
          <p className="text-lg font-semibold text-white">
            {baristaContribution <= 0 ? 'Already there' : `${fmt(baristaContribution)}/yr`}
          </p>
          {baristaContribution > 0 && (
            <p className="text-xs text-slate-500 mt-1">
              {fmt(baristaContribution / 12)}/mo — vs current {fmt(annualContribution / 12)}/mo savings
            </p>
          )}
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-white mb-2">Drawdown Longevity</h3>
          <p className="text-xs text-slate-400 mb-2">
            Years your portfolio lasts in retirement at {fmt(annualSpending)}/yr spending.
          </p>
          <DrawdownDisplay years={drawdownYears} />
        </div>
      </div>
    </div>
  );
}

// --- Need the length for the success rate display ---
import { REAL_STOCK_RETURNS } from '../lib/fire/historical-returns';
const REAL_STOCK_RETURNS_LENGTH = REAL_STOCK_RETURNS.length;

// --- Subcomponents ---

function StatCard({ label, value, sub, highlight }: { label: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-3">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${highlight ? 'text-primary' : 'text-white'}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
    </div>
  );
}

function MilestoneCard({ title, target, spending, current, description, color }: {
  title: string; target: number; spending: number; current: number; description: string; color: string;
}) {
  const pct = Math.min((current / target) * 100, 100);
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className={`text-sm font-medium ${color}`}>{title}</h3>
        <span className="text-xs text-slate-500">{pct.toFixed(0)}%</span>
      </div>
      <div className="w-full h-1.5 bg-white/5 rounded-full mb-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${title} progress: ${pct.toFixed(0)}%`}>
        <div className="h-full rounded-full bg-primary/60 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-white">{fmt(target)}</p>
      <p className="text-xs text-slate-500">{description} — {fmt(spending)}/yr</p>
    </div>
  );
}

function DrawdownDisplay({ years }: { years: number }) {
  if (years >= 100) {
    return <p className="text-lg font-semibold text-primary">100+ years</p>;
  }
  return (
    <div>
      <p className={`text-lg font-semibold ${years >= 30 ? 'text-primary' : years >= 20 ? 'text-amber-400' : 'text-red-400'}`}>
        {years} years
      </p>
      <p className="text-xs text-slate-500 mt-1">
        {years >= 30 ? 'Comfortable' : years >= 20 ? 'Tight — consider reducing spending' : 'High risk of running out'}
      </p>
    </div>
  );
}
