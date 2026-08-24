/**
 * Maps Plaid's personal_finance_category.primary values to
 * default expense/income account names.
 *
 * Reference: https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv
 *
 * Transfer categories are NOT mapped here — they're handled by
 * the transfer detection pass in the matchmaker.
 */

export type PlaidCategoryMapping = {
  accountName: string;
  accountType: 'expense' | 'income';
};

const PLAID_CATEGORY_MAP: Record<string, PlaidCategoryMapping> = {
  // Expense categories
  'FOOD_AND_DRINK': { accountName: 'Food & Drink', accountType: 'expense' },
  'GROCERIES': { accountName: 'Groceries', accountType: 'expense' },
  'TRANSPORTATION': { accountName: 'Transportation', accountType: 'expense' },
  'TRAVEL': { accountName: 'Travel', accountType: 'expense' },
  'RENT_AND_UTILITIES': { accountName: 'Rent & Utilities', accountType: 'expense' },
  'GENERAL_MERCHANDISE': { accountName: 'Shopping', accountType: 'expense' },
  'HOME_IMPROVEMENT': { accountName: 'Home', accountType: 'expense' },
  'MEDICAL': { accountName: 'Medical', accountType: 'expense' },
  'PERSONAL_CARE': { accountName: 'Personal Care', accountType: 'expense' },
  'GENERAL_SERVICES': { accountName: 'Services', accountType: 'expense' },
  'ENTERTAINMENT': { accountName: 'Entertainment', accountType: 'expense' },
  'RECREATION': { accountName: 'Entertainment', accountType: 'expense' },
  'EDUCATION': { accountName: 'Education', accountType: 'expense' },
  'GOVERNMENT_AND_NON_PROFIT': { accountName: 'Taxes & Fees', accountType: 'expense' },
  'BANK_FEES': { accountName: 'Bank Fees', accountType: 'expense' },
  // LOAN_PAYMENTS is in TRANSFER_CATEGORIES — handled by transfer detection
  'INSURANCE': { accountName: 'Insurance', accountType: 'expense' },
  'SUBSCRIPTION': { accountName: 'Subscriptions', accountType: 'expense' },
  'PET': { accountName: 'Pets', accountType: 'expense' },
  'CHILDCARE': { accountName: 'Childcare', accountType: 'expense' },
  'CHARITABLE_DONATIONS': { accountName: 'Donations', accountType: 'expense' },

  // Income categories
  'INCOME': { accountName: 'Other Income', accountType: 'income' },
  'SALARY': { accountName: 'Paychecks', accountType: 'income' },
  'INTEREST': { accountName: 'Interest', accountType: 'income' },
  'DIVIDENDS': { accountName: 'Dividends', accountType: 'income' },
  'INVESTMENT_INCOME': { accountName: 'Investment Income', accountType: 'income' },
  'REFUND': { accountName: 'Returns', accountType: 'income' },
};

// Categories that indicate transfers — handled by transfer detection, not auto-categorization
// Exported for use by matchmaker's transfer routing
export const TRANSFER_CATEGORIES = new Set([
  'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER_DEBIT', 'TRANSFER_CREDIT',
  'LOAN_PAYMENTS', 'LOAN_DISBURSEMENTS',
]);

/**
 * Look up the expense/income account for a Plaid category.
 * Returns null for transfer categories or unknown categories.
 */
export function mapPlaidCategory(plaidCategory: string | null): PlaidCategoryMapping | null {
  if (!plaidCategory) return null;
  if (TRANSFER_CATEGORIES.has(plaidCategory)) return null;
  return PLAID_CATEGORY_MAP[plaidCategory] || null;
}

