import {
  getYearConfig,
  NIIT_THRESHOLD_MFJ,
  NIIT_RATE,
  MORTGAGE_LIMIT,
  SAFE_HARBOR_MULTIPLIER,
  SOCIAL_SECURITY_RATE,
  MEDICARE_RATE,
  ADDITIONAL_MEDICARE_THRESHOLD,
  ADDITIONAL_MEDICARE_RATE,
  type TaxBracket,
  type YearConfig,
} from './brackets';

// --- Input types ---

export interface QuarterlyAmount {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export interface PersonIncome extends QuarterlyAmount {
  name: string;
}

export interface TradingAccount extends QuarterlyAmount {
  name: string;
}

export interface TaxInputs {
  taxYear: number;

  // W2 income per person per quarter (gross)
  w2Income: [PersonIncome, PersonIncome];

  // W2 withholdings (YTD)
  federalWithholding: [number, number];
  stateWithholding: [number, number];

  // Section 1256 trading income per account per quarter
  tradingAccounts: TradingAccount[];

  // Schedule C / self-employment income (non-1256 business income)
  scheduleC: {
    grossRevenue: number;
    expenses: number;  // business expenses (hosting, tools, contractors, etc.)
  };

  // Additional itemizable deductions
  charitableContributions: number;

  // Deductions
  mortgageBalance: number;
  annualPropertyTax: number;
  annualMortgageInterest: number;

  // Safe harbor — split by jurisdiction for accurate payment planning
  priorYearFederalTax: number;
  priorYearCATax: number;

  // Estimated payments already made (federal)
  estimatedPayments: [number, number, number, number]; // Q1-Q4
  // Estimated payments already made (CA)
  caEstimatedPayments: [number, number, number, number];
}

// --- Output types ---

export interface TaxResult {
  // Income totals
  ordinaryIncome: number;
  totalTradingIncome: number;
  totalIncome: number;

  // Federal deductions
  federalSALTDeduction: number;      // min(propertyTax + stateIncomeTax, saltCap)
  federalMortgageInterest: number;   // prorated if mortgage > $750k
  totalFederalDeductions: number;
  taxableOrdinaryIncome: number;

  // CA deductions (no SALT cap, no mortgage limit)
  caDeductions: number;

  // Federal
  federalOrdinaryTax: number;
  federalOrdinaryRate: number;
  federalBusinessTax: number;
  federalNIIT: number;
  federalTotalTax: number;
  federalWithholding: number;
  federalRemaining: number;

  // Business income detail
  businessDetail: {
    stLayerBase: number;
    ltPortion: number;
    marginalRate: number;
    ltAt0: number;
    ltAt15: number;
    ltAt20: number;
  };

  // CA
  caTaxableIncome: number;
  caTax: number;
  caWithholding: number;
  caRemaining: number;

  // Safe harbor
  safeHarborTarget: number;
  safeHarborShortfall: number;

  // Quarterly business tax allocations
  quarterlyBusinessTax: [number, number, number, number];

  // Schedule C / self-employment
  scheduleCNet: number;
  seTax: number;
  seTaxDeduction: number;  // deductible half of SE tax (above-the-line)

  // Standard vs itemized comparison
  standardDeduction: number;
  itemizedIsBetter: boolean;
  deductionSavings: number;  // how much itemized saves vs standard (or vice versa)

  // Trading tax impact
  tradingTaxImpact: number;  // how much more tax you owe because of trading income

  // Grand total
  totalTaxOwed: number;
  totalWithholding: number;
  totalRemaining: number;

  // Payment planner
  paymentPlan: PaymentPlan;

  // Year config used (for display)
  yearUsed: number;
}

export interface QuarterlyPaymentStatus {
  quarter: string;
  deadline: string;
  isPast: boolean;
  federalRequired: number;    // cumulative required by this deadline
  federalPaid: number;        // cumulative paid (withholding + estimated)
  federalShortfall: number;   // how much behind
  caRequired: number;
  caPaid: number;
  caShortfall: number;
}

export interface PaymentPlan {
  safeHarborFederalTarget: number;   // 110% of prior year federal
  safeHarborCATarget: number;        // not computed separately (use total)
  totalEstimatedPaid: number;
  totalCaEstimatedPaid: number;
  quarters: QuarterlyPaymentStatus[];
  nextAction: string;                // human-readable "pay $X by date"
}

// --- Helpers ---

function computeBracketTax(taxableIncome: number, brackets: TaxBracket[]): number {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (taxableIncome > brackets[i].floor) {
      tax = brackets[i].baseTax + (taxableIncome - brackets[i].floor) * brackets[i].rate;
      break;
    }
  }
  return tax;
}

function findMarginalRate(taxableIncome: number, brackets: TaxBracket[]): number {
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (taxableIncome > brackets[i].floor) return brackets[i].rate;
  }
  return brackets[0].rate;
}

function sumQuarters(q: QuarterlyAmount): number {
  return q.q1 + q.q2 + q.q3 + q.q4;
}

function computeSALTCap(agi: number, cfg: YearConfig): number {
  if (agi <= cfg.saltPhaseoutAGI) return cfg.saltCapDefault;
  const excess = agi - cfg.saltPhaseoutAGI;
  const reduction = Math.min(excess * 0.30, cfg.saltCapDefault - cfg.saltCapFloor);
  return cfg.saltCapDefault - reduction;
}

// --- Main computation ---

export function computeTax(inputs: TaxInputs): TaxResult {
  const cfg = getYearConfig(inputs.taxYear);

  // --- Income ---
  const person1W2 = sumQuarters(inputs.w2Income[0]);
  const person2W2 = sumQuarters(inputs.w2Income[1]);
  const w2Income = person1W2 + person2W2;

  const tradingByAccount = inputs.tradingAccounts.map(a => sumQuarters(a));
  const totalTradingIncome = tradingByAccount.reduce((s, v) => s + v, 0);

  // --- Schedule C (self-employment) ---
  const scheduleCNet = inputs.scheduleC.grossRevenue - inputs.scheduleC.expenses;
  // SE tax: 92.35% of net SE income is the SE tax base
  const seTaxBase = Math.max(0, scheduleCNet * 0.9235);
  const ssSECap = Math.max(0, cfg.socialSecurityWageCap - w2Income); // reduce SS cap by W2 wages
  const ssTax = Math.min(seTaxBase, ssSECap) * 0.124; // 12.4% SS (both halves)
  const medicareSE = seTaxBase * 0.029; // 2.9% Medicare (both halves)
  const additionalMedicareSE = Math.max(0, w2Income + seTaxBase - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;
  // Only count the additional Medicare above what W2 already triggers
  const w2AdditionalMedicare = Math.max(0, w2Income - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;
  const netAdditionalMedicareSE = Math.max(0, additionalMedicareSE - w2AdditionalMedicare);
  const seTax = ssTax + medicareSE + netAdditionalMedicareSE;
  const seTaxDeduction = seTax / 2; // deductible half (above-the-line)

  // Ordinary income includes W2 + Schedule C net (can be negative = loss offsets W2)
  const ordinaryIncome = w2Income + scheduleCNet;
  const totalIncome = ordinaryIncome + totalTradingIncome;

  // --- Federal Deductions ---
  // Above-the-line: deductible half of SE tax
  const agiBeforeDeductions = totalIncome - seTaxDeduction;

  // SALT = property tax + state income tax paid (withholding + estimated payments), capped
  const caWithholding = inputs.stateWithholding[0] + inputs.stateWithholding[1];
  const caEstimatedTotal = inputs.caEstimatedPayments.reduce((s, v) => s + v, 0);
  const stateIncomeTaxPaid = caWithholding + caEstimatedTotal;
  const saltCap = computeSALTCap(agiBeforeDeductions, cfg);
  const federalSALTDeduction = Math.min(inputs.annualPropertyTax + stateIncomeTaxPaid, saltCap);

  // Mortgage interest: prorated if balance > $750k (federal limit)
  let federalMortgageInterest = inputs.annualMortgageInterest;
  if (inputs.mortgageBalance > MORTGAGE_LIMIT) {
    federalMortgageInterest = inputs.annualMortgageInterest * (MORTGAGE_LIMIT / inputs.mortgageBalance);
  }

  // Charitable contributions
  const itemizedTotal = federalSALTDeduction + federalMortgageInterest + inputs.charitableContributions;
  const totalFederalDeductions = itemizedTotal;
  const standardDeduction = cfg.standardDeductionMFJ;
  const itemizedIsBetter = itemizedTotal > standardDeduction;
  const effectiveDeduction = Math.max(itemizedTotal, standardDeduction);
  // Taxable ordinary = AGI (after SE deduction) minus itemized/standard
  const taxableOrdinaryIncome = Math.max(0, agiBeforeDeductions - effectiveDeduction);
  const deductionSavings = Math.abs(itemizedTotal - standardDeduction);

  // --- CA Deductions ---
  // CA conforms to federal $750k mortgage limit for post-2017 originations (R&TC §17201).
  // Default to federal limit (conservative). CA has no SALT cap on property tax.
  // CA doesn't allow deducting state income tax from itself.
  let caMortgageInterest = inputs.annualMortgageInterest;
  if (inputs.mortgageBalance > MORTGAGE_LIMIT) {
    caMortgageInterest = inputs.annualMortgageInterest * (MORTGAGE_LIMIT / inputs.mortgageBalance);
  }
  const caDeductions = inputs.annualPropertyTax + caMortgageInterest + inputs.charitableContributions;

  // --- Federal Ordinary Tax ---
  const federalOrdinaryTax = computeBracketTax(taxableOrdinaryIncome, cfg.federalMFJ);
  const federalOrdinaryRate = taxableOrdinaryIncome > 0
    ? federalOrdinaryTax / taxableOrdinaryIncome
    : 0;

  // --- Section 1256 Business Income Tax (bracket stacking) ---
  const stPortion = totalTradingIncome * 0.40;
  const ltPortion = totalTradingIncome * 0.60;

  const stLayerBase = taxableOrdinaryIncome + stPortion;
  const stTax = computeBracketTax(stLayerBase, cfg.federalMFJ) - federalOrdinaryTax;
  const marginalRate = findMarginalRate(stLayerBase, cfg.federalMFJ);

  // Long-term: bracket stacking on top of ordinary + ST
  const ordinaryPlusST = stLayerBase;
  let ltAt0 = 0;
  let ltAt15 = 0;
  let ltAt20 = 0;
  let ltRemaining = ltPortion;

  const ltThresholds = cfg.ltcgMFJ;

  if (ordinaryPlusST < ltThresholds[1].floor && ltRemaining > 0) {
    const room = ltThresholds[1].floor - ordinaryPlusST;
    ltAt0 = Math.min(ltRemaining, room);
    ltRemaining -= ltAt0;
  }

  const lt15Start = Math.max(ordinaryPlusST, ltThresholds[1].floor);
  if (lt15Start < ltThresholds[2].floor && ltRemaining > 0) {
    const room = ltThresholds[2].floor - lt15Start;
    ltAt15 = Math.min(ltRemaining, room);
    ltRemaining -= ltAt15;
  }

  ltAt20 = ltRemaining;

  const ltTax = ltAt0 * 0.00 + ltAt15 * 0.15 + ltAt20 * 0.20;
  const federalBusinessTax = stTax + ltTax;

  // --- Trading tax impact (federal business tax + NIIT + CA on trading) ---
  // CA portion: marginal CA tax on trading income
  const caWithoutTrading = computeBracketTax(Math.max(0, ordinaryIncome - seTaxDeduction - caDeductions), cfg.caMFJ);

  // --- NIIT ---
  // TODO: expand NII when interest/dividend income types are added
  // NII should include all investment income (interest, dividends, rental, capital gains)
  const magi = totalIncome;
  const niitBase = Math.max(0, magi - NIIT_THRESHOLD_MFJ);
  const niitableIncome = Math.min(totalTradingIncome, niitBase);
  const federalNIIT = niitableIncome * NIIT_RATE;

  // --- Federal total (includes SE tax) ---
  const federalTotalTax = federalOrdinaryTax + federalBusinessTax + federalNIIT + seTax;
  const federalWithholding = inputs.federalWithholding[0] + inputs.federalWithholding[1];

  // --- Quarterly business tax allocation ---
  const quarterlyTradingTotals = [0, 0, 0, 0];
  for (const acct of inputs.tradingAccounts) {
    quarterlyTradingTotals[0] += acct.q1;
    quarterlyTradingTotals[1] += acct.q2;
    quarterlyTradingTotals[2] += acct.q3;
    quarterlyTradingTotals[3] += acct.q4;
  }
  // Quarterly allocation: clamp negative quarters to 0, redistribute proportionally
  // (a loss quarter doesn't generate a refund obligation for estimated payments)
  const quarterlyBusinessTax: [number, number, number, number] = [0, 0, 0, 0];
  const positiveQuarters = quarterlyTradingTotals.map(v => Math.max(0, v));
  const positiveTotal = positiveQuarters.reduce((s, v) => s + v, 0);
  if (positiveTotal > 0 && federalBusinessTax > 0) {
    for (let i = 0; i < 4; i++) {
      quarterlyBusinessTax[i] = federalBusinessTax * (positiveQuarters[i] / positiveTotal);
    }
  }

  // --- CA Tax ---
  // CA conforms to federal above-the-line SE deduction (R&TC §17072)
  const caTaxableIncome = Math.max(0, totalIncome - seTaxDeduction - caDeductions);
  const caTax = computeBracketTax(caTaxableIncome, cfg.caMFJ);

  // --- Safe Harbor + Totals ---
  const priorYearTotal = inputs.priorYearFederalTax + inputs.priorYearCATax;
  const safeHarborTarget = priorYearTotal * SAFE_HARBOR_MULTIPLIER;
  const totalEstimatedPaid = inputs.estimatedPayments.reduce((s, v) => s + v, 0);
  const totalCaEstimatedPaid = inputs.caEstimatedPayments.reduce((s, v) => s + v, 0);
  const totalWithholding = federalWithholding + caWithholding;
  const totalAllPaid = totalWithholding + totalEstimatedPaid + totalCaEstimatedPaid;
  const totalTaxOwed = federalTotalTax + caTax;
  const safeHarborShortfall = Math.max(0, safeHarborTarget - totalAllPaid);
  const totalRemaining = totalTaxOwed - totalAllPaid;
  const federalRemaining = federalTotalTax - federalWithholding - totalEstimatedPaid;
  const caRemaining = caTax - caWithholding - totalCaEstimatedPaid;

  // --- Payment Planner ---
  const paymentPlan = computePaymentPlan(
    inputs, federalTotalTax, caTax, federalWithholding, caWithholding,
  );

  return {
    ordinaryIncome,
    totalTradingIncome,
    totalIncome,
    scheduleCNet,
    seTax,
    seTaxDeduction,
    federalSALTDeduction,
    federalMortgageInterest,
    totalFederalDeductions,
    taxableOrdinaryIncome,
    caDeductions,
    federalOrdinaryTax,
    federalOrdinaryRate,
    federalBusinessTax,
    federalNIIT,
    federalTotalTax,
    federalWithholding,
    federalRemaining,
    businessDetail: { stLayerBase, ltPortion, marginalRate, ltAt0, ltAt15, ltAt20 },
    caTaxableIncome,
    caTax,
    caWithholding,
    caRemaining,
    standardDeduction,
    itemizedIsBetter,
    deductionSavings,
    tradingTaxImpact: federalBusinessTax + federalNIIT + (caTax - caWithoutTrading),
    safeHarborTarget,
    safeHarborShortfall,
    quarterlyBusinessTax,
    totalTaxOwed,
    totalWithholding,
    totalRemaining,
    paymentPlan,
    yearUsed: inputs.taxYear,
  };
}

// --- Payment Planner ---

function computePaymentPlan(
  inputs: TaxInputs,
  federalTotalTax: number,
  caTax: number,
  federalWithholding: number,
  caWithholding: number,
): PaymentPlan {
  const year = inputs.taxYear;
  const today = new Date();

  // IRS quarterly deadlines
  const deadlines = [
    { quarter: 'Q1', deadline: `${year}-04-15`, label: `Apr 15, ${year}` },
    { quarter: 'Q2', deadline: `${year}-06-15`, label: `Jun 15, ${year}` },
    { quarter: 'Q3', deadline: `${year}-09-15`, label: `Sep 15, ${year}` },
    { quarter: 'Q4', deadline: `${year + 1}-01-15`, label: `Jan 15, ${year + 1}` },
  ];

  // Safe harbor: pay min(100% current year, 110% prior year) — per jurisdiction
  const safeFederalTarget = inputs.priorYearFederalTax > 0
    ? Math.min(federalTotalTax, inputs.priorYearFederalTax * SAFE_HARBOR_MULTIPLIER)
    : federalTotalTax;
  // CA safe harbor: technically 100% if prior-year AGI <= $1M, 110% if > $1M.
  // We use 110% (conservative) — overpaying is always safe, underpaying triggers penalties.
  const caMultiplier = SAFE_HARBOR_MULTIPLIER;
  const safeCATarget = inputs.priorYearCATax > 0
    ? Math.min(caTax, inputs.priorYearCATax * caMultiplier)
    : caTax;

  // Withholding accrues evenly across quarters (simplification)
  const fedWithholdingPerQ = federalWithholding / 4;
  const caWithholdingPerQ = caWithholding / 4;

  // Federal: 25/25/25/25 quarterly fractions
  // CA: 30/40/0/30 per FTB Form 5805
  const federalFractions = [0.25, 0.50, 0.75, 1.00]; // cumulative
  const caFractions = [0.30, 0.70, 0.70, 1.00]; // cumulative (Q3 = 0% additional)

  const quarters: QuarterlyPaymentStatus[] = deadlines.map((d, i) => {
    const isPast = today > new Date(d.deadline);

    // Cumulative federal
    const cumulativeFedWithholding = fedWithholdingPerQ * (i + 1);
    const cumulativeFedEstimated = inputs.estimatedPayments.slice(0, i + 1).reduce((s, v) => s + v, 0);
    const federalPaid = cumulativeFedWithholding + cumulativeFedEstimated;
    const federalRequired = safeFederalTarget * federalFractions[i];

    // Cumulative CA (30/40/0/30 schedule)
    const cumulativeCAWithholding = caWithholdingPerQ * (i + 1);
    const cumulativeCAEstimated = inputs.caEstimatedPayments.slice(0, i + 1).reduce((s, v) => s + v, 0);
    const caPaid = cumulativeCAWithholding + cumulativeCAEstimated;
    const caRequired = safeCATarget * caFractions[i];

    return {
      quarter: d.quarter,
      deadline: d.label,
      isPast,
      federalRequired: Math.round(federalRequired),
      federalPaid: Math.round(federalPaid),
      federalShortfall: Math.max(0, Math.round(federalRequired - federalPaid)),
      caRequired: Math.round(caRequired),
      caPaid: Math.round(caPaid),
      caShortfall: Math.max(0, Math.round(caRequired - caPaid)),
    };
  });

  // Next action: find the next unpaid quarter with a shortfall
  const nextDue = quarters.find(q => !q.isPast && (q.federalShortfall > 0 || q.caShortfall > 0));
  let nextAction = 'All estimated payments are on track.';
  if (nextDue) {
    const parts: string[] = [];
    if (nextDue.federalShortfall > 0) parts.push(`$${nextDue.federalShortfall.toLocaleString()} federal`);
    if (nextDue.caShortfall > 0) parts.push(`$${nextDue.caShortfall.toLocaleString()} CA`);
    nextAction = `Pay ${parts.join(' + ')} by ${nextDue.deadline} for safe harbor.`;
  } else {
    // Check if any past quarters had shortfalls (catch-up needed)
    const pastShortfall = quarters.filter(q => q.isPast && (q.federalShortfall > 0 || q.caShortfall > 0));
    if (pastShortfall.length > 0) {
      const totalFedShort = pastShortfall.reduce((s, q) => s + q.federalShortfall, 0);
      const totalCAShort = pastShortfall.reduce((s, q) => s + q.caShortfall, 0);
      const parts: string[] = [];
      if (totalFedShort > 0) parts.push(`$${totalFedShort.toLocaleString()} federal`);
      if (totalCAShort > 0) parts.push(`$${totalCAShort.toLocaleString()} CA`);
      nextAction = `Behind on estimated payments — catch up: ${parts.join(' + ')}.`;
    }
  }

  return {
    safeHarborFederalTarget: Math.round(safeFederalTarget),
    safeHarborCATarget: Math.round(safeCATarget),
    totalEstimatedPaid: inputs.estimatedPayments.reduce((s, v) => s + v, 0),
    totalCaEstimatedPaid: inputs.caEstimatedPayments.reduce((s, v) => s + v, 0),
    quarters,
    nextAction,
  };
}

// --- Withholding Estimator ---

export interface WithholdingEstimate {
  annualSalary: number;
  federalWithholding: number;
  caWithholding: number;
  ficaMedicare: number;
  totalWithholding: number;
  netPay: number;
}

export function estimateW2Withholding(annualSalary: number, taxYear: number = 2026): WithholdingEstimate {
  const cfg = getYearConfig(taxYear);

  // Federal withholding: approximate using half the MFJ standard deduction per earner
  const taxableIncome = Math.max(0, annualSalary - cfg.standardDeductionMFJ / 2);
  const federalWithholding = computeBracketTax(taxableIncome, cfg.federalMFJ);

  // CA withholding: approximate (CA withholds per-earner, use half MFJ brackets)
  const caWithholding = computeBracketTax(annualSalary, cfg.caMFJ) / 2;

  // FICA + Medicare
  const fica = Math.min(annualSalary, cfg.socialSecurityWageCap) * SOCIAL_SECURITY_RATE;
  const medicare = annualSalary * MEDICARE_RATE;
  const additionalMedicare = Math.max(0, annualSalary - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;
  const ficaMedicare = fica + medicare + additionalMedicare;

  const totalWithholding = federalWithholding + caWithholding + ficaMedicare;

  return {
    annualSalary,
    federalWithholding,
    caWithholding,
    ficaMedicare,
    totalWithholding,
    netPay: annualSalary - totalWithholding,
  };
}

// --- Net-to-Gross Reverse Calculator ---
// Given a net paycheck deposit, estimate the gross salary

export interface NetToGrossResult {
  netPerPaycheck: number;
  paychecksPerYear: number;
  estimatedAnnualNet: number;
  estimatedAnnualGross: number;
  estimatedFederalWithholding: number;
  estimatedCAWithholding: number;
  estimatedFICA: number;
}

export function reverseNetToGross(
  netPerPaycheck: number,
  paychecksPerYear: number = 24, // semi-monthly default
  taxYear: number = 2026,
): NetToGrossResult {
  const annualNet = netPerPaycheck * paychecksPerYear;

  // Binary search for gross salary that produces this net
  let lo = annualNet;
  let hi = annualNet * 2; // gross is always more than net
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const est = estimateW2Withholding(mid, taxYear);
    if (est.netPay < annualNet) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const gross = (lo + hi) / 2;
  const est = estimateW2Withholding(gross, taxYear);

  return {
    netPerPaycheck,
    paychecksPerYear,
    estimatedAnnualNet: annualNet,
    estimatedAnnualGross: Math.round(gross),
    estimatedFederalWithholding: Math.round(est.federalWithholding),
    estimatedCAWithholding: Math.round(est.caWithholding),
    estimatedFICA: Math.round(est.ficaMedicare),
  };
}

// --- Marginal Rate Analysis ---

export interface MarginalRateAnalysis {
  federalMarginalOrdinary: number;
  federalMarginalSTCG: number;
  federalMarginalLTCG: number;
  caMarginalRate: number;
  combinedMarginalST: number;
  combinedMarginalLT: number;
  harvestingValue: number;
}

export function computeMarginalRates(result: TaxResult): MarginalRateAnalysis {
  const cfg = getYearConfig(result.yearUsed);
  const totalIncome = result.totalIncome;

  const federalMarginalOrdinary = findMarginalRate(result.taxableOrdinaryIncome, cfg.federalMFJ);
  const federalMarginalSTCG = findMarginalRate(result.businessDetail.stLayerBase, cfg.federalMFJ);

  const ordinaryPlusST = result.businessDetail.stLayerBase;
  const ltStackPoint = ordinaryPlusST + result.businessDetail.ltPortion;
  let federalMarginalLTCG = 0.20;
  if (ltStackPoint < cfg.ltcgMFJ[1].floor) federalMarginalLTCG = 0.00;
  else if (ltStackPoint < cfg.ltcgMFJ[2].floor) federalMarginalLTCG = 0.15;

  const caMarginalRate = findMarginalRate(result.caTaxableIncome, cfg.caMFJ);
  const niitRate = totalIncome > NIIT_THRESHOLD_MFJ ? NIIT_RATE : 0;

  const combinedMarginalST = federalMarginalSTCG + caMarginalRate + niitRate;
  const combinedMarginalLT = federalMarginalLTCG + caMarginalRate + niitRate;

  const blendedFederalRate = 0.40 * federalMarginalSTCG + 0.60 * federalMarginalLTCG;
  const harvestingValue = (blendedFederalRate + caMarginalRate + niitRate) * 1000;

  return {
    federalMarginalOrdinary,
    federalMarginalSTCG,
    federalMarginalLTCG,
    caMarginalRate,
    combinedMarginalST,
    combinedMarginalLT,
    harvestingValue,
  };
}

// --- Retirement Tax Rate (for FIRE integration) ---
// Computes effective tax rate on retirement withdrawals (ordinary income, MFJ)
// Used by FIRE engine to gross up spending needs

export interface RetirementTaxEstimate {
  grossWithdrawal: number;       // how much to withdraw to net the target spending
  effectiveRate: number;          // combined federal + CA effective rate
  federalTax: number;
  caTax: number;
  totalTax: number;
}

export function computeRetirementTax(
  annualSpending: number,
  deductions: number = 30_000, // standard deduction MFJ as default
  taxYear: number = 2026,
): RetirementTaxEstimate {
  const cfg = getYearConfig(taxYear);

  // Binary search for gross withdrawal that nets the target spending after taxes
  let lo = annualSpending;
  let hi = annualSpending * 2;

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const taxableIncome = Math.max(0, mid - deductions);
    const fedTax = computeBracketTax(taxableIncome, cfg.federalMFJ);
    const caTax = computeBracketTax(mid, cfg.caMFJ); // CA uses full income (own deductions differ)
    const netAfterTax = mid - fedTax - caTax;
    if (netAfterTax < annualSpending) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const grossWithdrawal = Math.round((lo + hi) / 2);
  const taxableIncome = Math.max(0, grossWithdrawal - deductions);
  const federalTax = computeBracketTax(taxableIncome, cfg.federalMFJ);
  const caTax = computeBracketTax(grossWithdrawal, cfg.caMFJ);
  const totalTax = federalTax + caTax;
  const effectiveRate = grossWithdrawal > 0 ? totalTax / grossWithdrawal : 0;

  return { grossWithdrawal, effectiveRate, federalTax, caTax, totalTax };
}

// --- Default inputs ---

export function defaultInputs(taxYear: number): TaxInputs {
  return {
    taxYear,
    w2Income: [
      { name: 'Person 1', q1: 0, q2: 0, q3: 0, q4: 0 },
      { name: 'Person 2', q1: 0, q2: 0, q3: 0, q4: 0 },
    ],
    federalWithholding: [0, 0],
    stateWithholding: [0, 0],
    tradingAccounts: [],
    scheduleC: { grossRevenue: 0, expenses: 0 },
    charitableContributions: 0,
    mortgageBalance: 0,
    annualPropertyTax: 0,
    annualMortgageInterest: 0,
    priorYearFederalTax: 0,
    priorYearCATax: 0,
    estimatedPayments: [0, 0, 0, 0],
    caEstimatedPayments: [0, 0, 0, 0],
  };
}
