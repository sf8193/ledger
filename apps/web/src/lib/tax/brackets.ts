// Tax bracket data — year-keyed for easy updates when IRS publishes new thresholds
// To add a new year: copy the latest entry, update the numbers, add the key.

export interface TaxBracket {
  rate: number;
  floor: number;    // taxable income over this
  baseTax: number;  // cumulative tax at floor
}

export interface LTCGThreshold {
  rate: number;
  floor: number;
}

export interface YearConfig {
  federalMFJ: TaxBracket[];
  ltcgMFJ: LTCGThreshold[];
  caMFJ: TaxBracket[];
  standardDeductionMFJ: number;
  socialSecurityWageCap: number;  // for FICA calc
  // SALT cap (OBBBA 2025-2029: $40k default, phases to $10k floor above $500k AGI)
  saltCapDefault: number;
  saltCapFloor: number;
  saltPhaseoutAGI: number;
}

// --- 2025 ---
const Y2025: YearConfig = {
  federalMFJ: [
    { rate: 0.10, floor: 0,       baseTax: 0 },
    { rate: 0.12, floor: 24_801,  baseTax: 2_480 },
    { rate: 0.22, floor: 100_801, baseTax: 11_600 },
    { rate: 0.24, floor: 211_401, baseTax: 35_932 },
    { rate: 0.32, floor: 403_551, baseTax: 82_048 },
    { rate: 0.35, floor: 512_451, baseTax: 116_896 },
    { rate: 0.37, floor: 768_701, baseTax: 206_584 },
  ],
  ltcgMFJ: [
    { rate: 0.00, floor: 0 },
    { rate: 0.15, floor: 96_700 },
    { rate: 0.20, floor: 600_050 },
  ],
  caMFJ: [
    { rate: 0.010, floor: 0,         baseTax: 0 },
    { rate: 0.020, floor: 21_692,    baseTax: 217 },
    { rate: 0.040, floor: 51_426,    baseTax: 812 },
    { rate: 0.060, floor: 81_154,    baseTax: 2_001 },
    { rate: 0.080, floor: 112_656,   baseTax: 3_891 },
    { rate: 0.093, floor: 142_388,   baseTax: 6_270 },
    { rate: 0.103, floor: 727_460,   baseTax: 60_662 },
    { rate: 0.113, floor: 872_944,   baseTax: 75_627 },
    { rate: 0.123, floor: 1_000_000, baseTax: 89_984 },
    { rate: 0.133, floor: 1_454_900, baseTax: 145_937 },
  ],
  standardDeductionMFJ: 29_600,
  socialSecurityWageCap: 168_600,
  saltCapDefault: 40_000,
  saltCapFloor: 10_000,
  saltPhaseoutAGI: 500_000,
};

// --- 2026 ---
const Y2026: YearConfig = {
  federalMFJ: [
    { rate: 0.10, floor: 0,       baseTax: 0 },
    { rate: 0.12, floor: 24_801,  baseTax: 2_480 },
    { rate: 0.22, floor: 100_801, baseTax: 11_600 },
    { rate: 0.24, floor: 211_401, baseTax: 35_932 },
    { rate: 0.32, floor: 403_551, baseTax: 82_048 },
    { rate: 0.35, floor: 512_451, baseTax: 116_896 },
    { rate: 0.37, floor: 768_701, baseTax: 206_584 },
  ],
  ltcgMFJ: [
    { rate: 0.00, floor: 0 },
    { rate: 0.15, floor: 98_900 },
    { rate: 0.20, floor: 613_700 },
  ],
  caMFJ: [
    { rate: 0.010, floor: 0,         baseTax: 0 },
    { rate: 0.020, floor: 22_158,    baseTax: 222 },
    { rate: 0.040, floor: 52_528,    baseTax: 829 },
    { rate: 0.060, floor: 82_904,    baseTax: 2_044 },
    { rate: 0.080, floor: 115_084,   baseTax: 3_975 },
    { rate: 0.093, floor: 145_448,   baseTax: 6_404 },
    { rate: 0.103, floor: 742_958,   baseTax: 61_972 },
    { rate: 0.113, floor: 891_542,   baseTax: 77_277 },
    { rate: 0.123, floor: 1_000_000, baseTax: 89_532 },
    { rate: 0.133, floor: 1_485_906, baseTax: 149_299 },
  ],
  standardDeductionMFJ: 30_000,
  socialSecurityWageCap: 172_800, // estimated
  saltCapDefault: 40_000,
  saltCapFloor: 10_000,
  saltPhaseoutAGI: 500_000,
};

// --- Year lookup ---

const YEAR_CONFIGS: Record<number, YearConfig> = {
  2025: Y2025,
  2026: Y2026,
};

export function getYearConfig(year: number): YearConfig {
  // Return exact year if available, otherwise fall back to nearest available
  if (YEAR_CONFIGS[year]) return YEAR_CONFIGS[year];
  const years = Object.keys(YEAR_CONFIGS).map(Number).sort();
  const nearest = years.reduce((a, b) => Math.abs(b - year) < Math.abs(a - year) ? b : a);
  return YEAR_CONFIGS[nearest];
}

// --- Constants that don't change year-to-year (or rarely) ---

// NIIT threshold (MFJ) — not inflation-indexed
export const NIIT_THRESHOLD_MFJ = 250_000;
export const NIIT_RATE = 0.038;

// Mortgage interest deduction limit
export const MORTGAGE_LIMIT = 750_000;

// Safe harbor multiplier (110% if prior-year AGI > $150k)
export const SAFE_HARBOR_MULTIPLIER = 1.10;

// FICA rates
export const SOCIAL_SECURITY_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;
export const ADDITIONAL_MEDICARE_THRESHOLD = 200_000;
export const ADDITIONAL_MEDICARE_RATE = 0.009;
