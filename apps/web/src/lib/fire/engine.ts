import { REAL_STOCK_RETURNS, REAL_BOND_RETURNS } from './historical-returns';
import { computeRetirementTax } from '../tax/engine';

// --- Types ---

export interface TimelineEvent {
  id: string;
  label: string;
  age: number; // age when this kicks in
  endAge?: number; // optional: when this event ends (for temporary events)
  annualAmount: number; // dollar amount (meaning depends on type)
  type: 'income' | 'expense_reduction' | 'income_change' | 'one_time' | 'expense_temporary';
  // income: adds income post-retirement (pension, rental, part-time)
  // expense_reduction: reduces spending permanently from age onward (mortgage payoff)
  // income_change: changes annual income by this amount from age onward (job loss = negative)
  // one_time: single portfolio injection at this age (inheritance, windfall)
  // expense_temporary: adds expense from age to endAge, then removes it (childcare, college)
}

export interface AccountBucket {
  id: string;
  name: string;
  balance: number;
  type: 'taxable' | 'tax_deferred' | 'roth';
  annualReturn: number; // decimal, e.g. 0.07
}

export interface FireInputs {
  currentAge: number;
  retirementAge: number;
  currentPortfolio: number;
  annualContribution: number;
  annualSpending: number;
  nominalReturn: number; // percent
  inflation: number; // percent
  swr: number; // percent
  timelineEvents: TimelineEvent[];
  accountBuckets: AccountBucket[] | null; // null = simple mode
  stockAllocation: number; // 0-100, for historical sim blending
  socialSecurity: SocialSecurityInputs | null;
  returnPhases: ReturnPhase[]; // empty = use nominalReturn uniformly
  taxAwareWithdrawals: boolean; // if true, gross up retirement withdrawals for taxes
}

export interface ReturnPhase {
  id: string;
  fromAge: number;
  nominalReturn: number; // percent
}

export interface SocialSecurityInputs {
  enabled: boolean;
  monthlyBenefitAt67: number; // estimated PIA at full retirement age
  claimingAge: number; // 62-70
}

export interface ProjectionPoint {
  age: number;
  year: number;
  portfolio: number;
  fireTarget: number;
  leanTarget: number;
  fatTarget: number;
  // Monte Carlo percentiles
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  // Historical sequence percentiles
  hp10: number;
  hp25: number;
  hp50: number;
  hp75: number;
  hp90: number;
  // Stacked band deltas for correct rendering (MC)
  band_p10: number;      // base: p10 value
  band_p25_p10: number;  // p25 - p10 (outer low)
  band_p75_p25: number;  // p75 - p25 (inner/middle, darkest)
  band_p90_p75: number;  // p90 - p75 (outer high)
  // Stacked band deltas (historical)
  hband_p10: number;
  hband_p25_p10: number;
  hband_p75_p25: number;
  hband_p90_p75: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  fireAge: number | null;
  fireNumber: number;
  leanNumber: number;
  fatNumber: number;
  mcFireYears: PercentileSet | null;
  historicalSuccessRate: number; // 0-1, fraction of historical periods that survived
  historicalFireYears: PercentileSet | null;
}

interface PercentileSet {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

// --- PRNG ---

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randn(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function extractPercentiles(values: number[]): PercentileSet {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

// --- Spending at a given age, accounting for timeline events and Social Security ---

// Get one-time portfolio injection for this age (inheritance, windfall)
function getOneTimeInjection(age: number, events: TimelineEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === 'one_time' && event.age === age) {
      total += event.annualAmount;
    }
  }
  return total;
}

function getAnnualSpending(
  baseSpending: number,
  age: number,
  retirementAge: number,
  events: TimelineEvent[],
  ss: SocialSecurityInputs | null,
): number {
  let spending = baseSpending;

  for (const event of events) {
    if (age >= event.age) {
      // Permanent expense reduction (mortgage payoff, kids leave)
      if (event.type === 'expense_reduction') {
        spending += event.annualAmount; // negative amount reduces spending
      }
      // Post-retirement income reduces spending needs
      if (event.type === 'income' && age >= retirementAge) {
        spending -= event.annualAmount;
      }
      // Temporary expense (childcare, college) — active from age to endAge
      if (event.type === 'expense_temporary') {
        const endAge = event.endAge ?? event.age + 10;
        if (age < endAge) {
          spending += event.annualAmount; // positive = additional spending
        }
      }
    }
  }

  // Social Security reduces spending needs in retirement
  if (ss?.enabled && age >= ss.claimingAge) {
    const ssAnnual = computeSSBenefit(ss.monthlyBenefitAt67, ss.claimingAge) * 12;
    spending -= ssAnnual;
  }

  return Math.max(spending, 0);
}

function getAnnualIncome(
  baseContribution: number,
  age: number,
  retirementAge: number,
  events: TimelineEvent[],
): number {
  if (age >= retirementAge) return 0;
  let income = baseContribution;
  for (const event of events) {
    if (age >= event.age && age < retirementAge) {
      // Pre-retirement income events add to contributions
      if (event.type === 'income') {
        income += event.annualAmount;
      }
      // Income change (job loss, raise, one income) modifies contributions directly
      if (event.type === 'income_change') {
        income += event.annualAmount; // negative = income reduction
      }
    }
  }
  return Math.max(income, 0);
}

// --- Social Security ---

// Adjust PIA based on claiming age (relative to FRA of 67)
export function computeSSBenefit(piaAt67: number, claimingAge: number): number {
  if (claimingAge <= 62) {
    // 30% reduction for claiming at 62
    return piaAt67 * 0.70;
  } else if (claimingAge < 67) {
    // Linear reduction: ~6.67% per year for first 3 years before FRA,
    // ~5% per year for years 4-5 before FRA
    const monthsEarly = (67 - claimingAge) * 12;
    let reduction = 0;
    if (monthsEarly <= 36) {
      reduction = monthsEarly * (5 / 9 / 100);
    } else {
      reduction = 36 * (5 / 9 / 100) + (monthsEarly - 36) * (5 / 12 / 100);
    }
    return piaAt67 * (1 - reduction);
  } else if (claimingAge === 67) {
    return piaAt67;
  } else {
    // Delayed retirement credits: 8% per year after FRA, up to age 70
    const yearsDelayed = Math.min(claimingAge - 67, 3);
    return piaAt67 * (1 + yearsDelayed * 0.08);
  }
}

// Estimate PIA from average annual income (very rough)
export function estimatePIA(averageAnnualIncome: number): number {
  // 2024 bend points (approximate, inflation-adjusted)
  const monthlyIncome = averageAnnualIncome / 12;
  // AIME approximation (assume 35 years of work, income is already averaged)
  const aime = Math.min(monthlyIncome, 12000); // cap at ~$144k/yr

  // PIA formula with bend points
  let pia = 0;
  if (aime <= 1174) {
    pia = aime * 0.90;
  } else if (aime <= 7078) {
    pia = 1174 * 0.90 + (aime - 1174) * 0.32;
  } else {
    pia = 1174 * 0.90 + (7078 - 1174) * 0.32 + (aime - 7078) * 0.15;
  }
  return Math.round(pia);
}

// --- IRS Uniform Lifetime Table (2024+) ---
// Divisor by age for RMD calculation
const IRS_RMD_DIVISORS: Record<number, number> = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0,
  79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0,
  86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8,
  93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
  100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6,
};

function getRmdDivisor(age: number): number {
  if (age < 72) return 0; // no RMD required
  if (age > 105) return 4.6;
  return IRS_RMD_DIVISORS[age] ?? 4.6;
}

// --- Account-Aware Drawdown ---

export function drawdownFromBuckets(
  buckets: AccountBucket[],
  amount: number,
): AccountBucket[] {
  // Withdrawal order: taxable → tax-deferred → Roth
  const order: Array<'taxable' | 'tax_deferred' | 'roth'> = ['taxable', 'tax_deferred', 'roth'];
  let remaining = amount;
  const updated = buckets.map(b => ({ ...b }));

  for (const type of order) {
    if (remaining <= 0) break;
    for (const bucket of updated) {
      if (bucket.type !== type || remaining <= 0) continue;
      const withdraw = Math.min(bucket.balance, remaining);
      bucket.balance -= withdraw;
      remaining -= withdraw;
    }
  }

  return updated;
}

export function growBuckets(buckets: AccountBucket[]): AccountBucket[] {
  return buckets.map(b => ({
    ...b,
    balance: Math.max(0, b.balance * (1 + b.annualReturn)),
  }));
}

export function totalBucketBalance(buckets: AccountBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.balance, 0);
}

// Resolve nominal return for a given age, accounting for return phases
function getNominalReturnForAge(age: number, defaultNominal: number, phases: ReturnPhase[]): number {
  if (phases.length === 0) return defaultNominal;
  // Phases sorted by fromAge descending — find the first phase where age >= fromAge
  const sorted = [...phases].sort((a, b) => b.fromAge - a.fromAge);
  for (const phase of sorted) {
    if (age >= phase.fromAge) return phase.nominalReturn;
  }
  return defaultNominal; // before any phase starts
}

function getRealReturnForAge(age: number, defaultNominal: number, phases: ReturnPhase[], inflation: number): number {
  const nominal = getNominalReturnForAge(age, defaultNominal, phases);
  return (1 + nominal / 100) / (1 + inflation / 100) - 1;
}

// --- Main Projection Engine ---

const MC_TRIALS = 1000;
const MC_STDEV = 0.15;

// Simulate one year: grow portfolio (or buckets), then contribute or withdraw
// Returns new total portfolio value and mutated buckets (if applicable)
function simYear(
  portfolio: number,
  buckets: AccountBucket[] | null,
  returnRate: number,
  spending: number,
  contribution: number,
  isRetired: boolean,
  age: number,
): { portfolio: number; buckets: AccountBucket[] | null } {
  if (buckets && buckets.length > 0) {
    // Bucket mode: grow each bucket at its own rate, then withdraw in order
    let grown = growBuckets(buckets);

    if (isRetired) {
      // RMD for tax-deferred accounts (IRS Uniform Lifetime Table)
      const rmdDivisor = getRmdDivisor(age);
      if (rmdDivisor > 0) {
        for (const b of grown) {
          if (b.type === 'tax_deferred' && b.balance > 0) {
            const rmd = b.balance / rmdDivisor;
            const appliedRmd = Math.min(rmd, spending);
            b.balance -= rmd;
            spending = Math.max(0, spending - appliedRmd);
          }
        }
      }
      // Withdraw remaining spending in order: taxable → tax-deferred → Roth
      if (spending > 0) {
        grown = drawdownFromBuckets(grown, spending);
      }
    } else {
      // Accumulation: add contributions to taxable bucket (or first available)
      if (contribution > 0) {
        const target = grown.find(b => b.type === 'taxable') || grown[0];
        if (target) target.balance += contribution;
      }
    }

    return { portfolio: totalBucketBalance(grown), buckets: grown };
  }

  // Simple mode: single portfolio
  if (isRetired) {
    const p = portfolio * (1 + returnRate) - spending;
    return { portfolio: Math.max(0, p), buckets: null };
  }
  return { portfolio: portfolio * (1 + returnRate) + contribution, buckets: null };
}

export function computeProjection(inputs: FireInputs): ProjectionResult {
  const {
    currentAge, retirementAge, currentPortfolio, annualContribution,
    nominalReturn, inflation, annualSpending, swr,
    timelineEvents, accountBuckets, stockAllocation, socialSecurity,
    returnPhases,
  } = inputs;

  const defaultRealReturn = (1 + nominalReturn / 100) / (1 + inflation / 100) - 1;
  const maxAge = Math.max(retirementAge + 30, 90);
  const numYears = maxAge - currentAge + 1;
  const currentYear = new Date().getFullYear();
  const useBuckets = accountBuckets && accountBuckets.length > 0;

  // If tax-aware, compute gross withdrawal needed for the target net spending
  const taxGrossUp = inputs.taxAwareWithdrawals
    ? computeRetirementTax(annualSpending).grossWithdrawal
    : annualSpending;
  const grossSpending = inputs.taxAwareWithdrawals ? taxGrossUp : annualSpending;

  const fireNumber = grossSpending / (swr / 100);
  const leanNumber = (grossSpending * 0.7) / (swr / 100);
  const fatNumber = (grossSpending * 1.5) / (swr / 100);

  // --- Deterministic projection ---
  const detPortfolio: number[] = [];
  let portfolio = currentPortfolio;
  let buckets = useBuckets ? accountBuckets!.map(b => ({ ...b })) : null;
  let fireAge: number | null = null;

  for (let i = 0; i < numYears; i++) {
    const age = currentAge + i;
    detPortfolio.push(Math.round(portfolio));
    if (fireAge === null && portfolio >= fireNumber) fireAge = age;

    let spending = getAnnualSpending(annualSpending, age, retirementAge, timelineEvents, socialSecurity);
    const isRetired = age >= retirementAge;
    // Gross up withdrawals for taxes in retirement
    if (isRetired && inputs.taxAwareWithdrawals && spending > 0) {
      spending = computeRetirementTax(spending).grossWithdrawal;
    }
    const contribution = getAnnualIncome(annualContribution, age, retirementAge, timelineEvents);
    const realReturn = getRealReturnForAge(age, nominalReturn, returnPhases, inflation);

    const result = simYear(portfolio, buckets, realReturn, spending, contribution, isRetired, age);
    portfolio = result.portfolio + getOneTimeInjection(age, timelineEvents);
    buckets = result.buckets;
    if (portfolio < 0) portfolio = 0;
  }

  // --- Monte Carlo ---
  const seed = Math.round(
    currentAge * 1000 + retirementAge * 100 + currentPortfolio * 0.01 +
    annualContribution * 0.1 + defaultRealReturn * 10000 + annualSpending * 0.01
  );
  const rng = mulberry32(seed);

  const mcTrialValues: number[][] = [];
  const mcFireYearsList: number[] = [];

  for (let t = 0; t < MC_TRIALS; t++) {
    const values: number[] = [];
    let p = currentPortfolio;
    let mcBuckets = useBuckets ? accountBuckets!.map(b => ({ ...b })) : null;
    let trialFireYear: number | null = null;

    for (let i = 0; i < numYears; i++) {
      const age = currentAge + i;
      values.push(Math.max(0, Math.round(p)));
      if (trialFireYear === null && p >= fireNumber) trialFireYear = i;

      const ageRealReturn = getRealReturnForAge(age, nominalReturn, returnPhases, inflation);
      const mu = Math.log(1 + ageRealReturn) - 0.5 * MC_STDEV * MC_STDEV;
      const annualRet = Math.exp(mu + MC_STDEV * randn(rng)) - 1;
      let spending = getAnnualSpending(annualSpending, age, retirementAge, timelineEvents, socialSecurity);
      const isRetired = age >= retirementAge;
      if (isRetired && inputs.taxAwareWithdrawals && spending > 0) {
        spending = computeRetirementTax(spending).grossWithdrawal;
      }
      const contribution = getAnnualIncome(annualContribution, age, retirementAge, timelineEvents);

      // For bucket mode in MC, override all bucket returns with the random return
      if (mcBuckets) {
        for (const b of mcBuckets) b.annualReturn = annualRet;
      }

      const result = simYear(p, mcBuckets, annualRet, spending, contribution, isRetired, age);
      p = result.portfolio + getOneTimeInjection(age, timelineEvents);
      mcBuckets = result.buckets;
      if (p < 0) p = 0;
    }

    mcTrialValues.push(values);
    if (trialFireYear !== null) mcFireYearsList.push(trialFireYear);
  }

  // --- Historical sequence testing ---
  const stockAlloc = stockAllocation / 100;
  const bondAlloc = 1 - stockAlloc;
  const totalHistYears = REAL_STOCK_RETURNS.length;

  const histTrialValues: number[][] = [];
  const histFireYearsList: number[] = [];
  let histSurvived = 0;
  let histTotal = 0;

  // Test every possible starting year window
  for (let startIdx = 0; startIdx + numYears <= totalHistYears; startIdx++) {
    const values: number[] = [];
    let p = currentPortfolio;
    let histBuckets = useBuckets ? accountBuckets!.map(b => ({ ...b })) : null;
    let trialFireYear: number | null = null;
    let survived = true;

    for (let i = 0; i < numYears; i++) {
      const age = currentAge + i;
      values.push(Math.max(0, Math.round(p)));
      if (trialFireYear === null && p >= fireNumber) trialFireYear = i;

      const stockRet = REAL_STOCK_RETURNS[startIdx + i];
      const bondRet = REAL_BOND_RETURNS[startIdx + i];
      const blendedReturn = stockAlloc * stockRet + bondAlloc * bondRet;

      let spending = getAnnualSpending(annualSpending, age, retirementAge, timelineEvents, socialSecurity);
      const isRetired = age >= retirementAge;
      if (isRetired && inputs.taxAwareWithdrawals && spending > 0) {
        spending = computeRetirementTax(spending).grossWithdrawal;
      }
      const contribution = getAnnualIncome(annualContribution, age, retirementAge, timelineEvents);

      if (histBuckets) {
        for (const b of histBuckets) b.annualReturn = blendedReturn;
      }

      const result = simYear(p, histBuckets, blendedReturn, spending, contribution, isRetired, age);
      p = result.portfolio + getOneTimeInjection(age, timelineEvents);
      histBuckets = result.buckets;
      if (isRetired && p <= 0) { survived = false; p = 0; }
    }

    histTrialValues.push(values);
    if (trialFireYear !== null) histFireYearsList.push(trialFireYear);
    if (survived) histSurvived++;
    histTotal++;
  }

  const historicalSuccessRate = histTotal > 0 ? histSurvived / histTotal : 0;

  // --- Assemble points ---
  const points: ProjectionPoint[] = [];
  for (let i = 0; i < numYears; i++) {
    const mcYear = mcTrialValues.map(tv => tv[i]).sort((a, b) => a - b);
    const histYear = histTrialValues.length > 0
      ? histTrialValues.map(tv => tv[i]).sort((a, b) => a - b)
      : mcYear; // fallback if no historical data

    const mp10 = Math.round(percentile(mcYear, 10));
    const mp25 = Math.round(percentile(mcYear, 25));
    const mp75 = Math.round(percentile(mcYear, 75));
    const mp90 = Math.round(percentile(mcYear, 90));
    const hp10v = Math.round(percentile(histYear, 10));
    const hp25v = Math.round(percentile(histYear, 25));
    const hp75v = Math.round(percentile(histYear, 75));
    const hp90v = Math.round(percentile(histYear, 90));

    points.push({
      age: currentAge + i,
      year: currentYear + i,
      portfolio: detPortfolio[i],
      fireTarget: Math.round(fireNumber),
      leanTarget: Math.round(leanNumber),
      fatTarget: Math.round(fatNumber),
      p10: mp10, p25: mp25, p75: mp75, p90: mp90,
      hp10: hp10v, hp25: hp25v,
      hp50: Math.round(percentile(histYear, 50)),
      hp75: hp75v, hp90: hp90v,
      // Stacked band deltas for correct rendering
      band_p10: mp10,
      band_p25_p10: Math.max(0, mp25 - mp10),
      band_p75_p25: Math.max(0, mp75 - mp25),
      band_p90_p75: Math.max(0, mp90 - mp75),
      hband_p10: hp10v,
      hband_p25_p10: Math.max(0, hp25v - hp10v),
      hband_p75_p25: Math.max(0, hp75v - hp25v),
      hband_p90_p75: Math.max(0, hp90v - hp75v),
    });
  }

  return {
    points,
    fireAge,
    fireNumber,
    leanNumber,
    fatNumber,
    mcFireYears: mcFireYearsList.length > 0 ? extractPercentiles(mcFireYearsList) : null,
    historicalSuccessRate,
    historicalFireYears: histFireYearsList.length > 0 ? extractPercentiles(histFireYearsList) : null,
  };
}

// --- Drawdown longevity ---

export function computeDrawdownYears(portfolio: number, annualSpending: number, realReturnPct: number): number {
  if (annualSpending <= 0) return Infinity;
  let p = portfolio;
  const r = realReturnPct / 100;
  let y = 0;
  while (p > 0 && y < 100) {
    p = p * (1 + r) - annualSpending;
    y++;
  }
  return y;
}

// --- Coast FIRE ---

export function computeCoastNumber(fireNumber: number, realReturnPct: number, yearsToRetirement: number): number {
  if (yearsToRetirement <= 0) return fireNumber;
  return fireNumber / Math.pow(1 + realReturnPct / 100, yearsToRetirement);
}

// --- Barista FIRE ---

export function computeBaristaContribution(
  fireNumber: number, currentPortfolio: number,
  yearsToRetirement: number, realReturnPct: number,
): number {
  if (yearsToRetirement <= 0) return 0;
  const r = realReturnPct / 100;
  if (r === 0) return Math.max(0, (fireNumber - currentPortfolio) / yearsToRetirement);
  const fv = currentPortfolio * Math.pow(1 + r, yearsToRetirement);
  const needed = fireNumber - fv;
  if (needed <= 0) return 0;
  const annuityFactor = (Math.pow(1 + r, yearsToRetirement) - 1) / r;
  return needed / annuityFactor;
}
