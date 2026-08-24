# Double-Entry Accounting Schema — Ledger

## Core Concept

Every financial event is a **journal entry** with two or more **lines** that must sum to zero (debits = credits). This eliminates the entire class of sign-convention bugs and makes transfers, payments, and net worth mathematically correct by construction.

## Account Types (Chart of Accounts)

Unify `financial_accounts` and `categories` into one `accounts` table with a type:

| Type | Normal Balance | Examples |
|------|---------------|----------|
| `asset` | Debit (+) | Checking, 401k, House |
| `liability` | Credit (+) | Credit Card, Mortgage |
| `income` | Credit (+) | Paychecks, Interest, Dividends |
| `expense` | Debit (+) | Groceries, Restaurants, Shopping |
| `equity` | Credit (+) | Opening Balances (used for initial import) |

**Key insight:** today's "categories" become `expense` and `income` accounts. Today's "financial_accounts" become `asset` and `liability` accounts. Same data, unified model.

## Schema

### `accounts` table (replaces both `financial_accounts` and `categories`)

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'income', 'expense', 'equity')),

  -- For asset/liability accounts (bank-linked)
  plaid_item_id TEXT REFERENCES plaid_items(id) ON DELETE SET NULL,
  plaid_account_id TEXT,
  institution_name TEXT,
  mask TEXT,
  subtype TEXT,           -- checking, savings, credit card, mortgage, etc.
  current_balance NUMERIC(14,2) DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,

  -- For expense/income accounts (categories)
  icon TEXT,
  color TEXT,
  parent_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Common
  is_manual BOOLEAN NOT NULL DEFAULT FALSE,
  owner TEXT,             -- for filtering by household member
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `journal_entries` table (replaces `transactions`)

```sql
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT NOT NULL,      -- "Grocery Store", "Paycheck", "Transfer to Savings"
  merchant_name TEXT,
  notes TEXT,
  owner TEXT,                     -- household member name
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,

  -- Import metadata
  plaid_transaction_id TEXT UNIQUE,
  source TEXT,                    -- 'plaid', 'monarch_import', 'manual'

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `journal_lines` table (the double-entry core)

```sql
CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount NUMERIC(14,2) NOT NULL,  -- positive = debit, negative = credit

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CRITICAL CONSTRAINT: lines must sum to zero per entry
-- Enforced via trigger or application-level check
```

## How Transactions Map

### Grocery purchase: $85 from Checking
```
journal_entry: { date: "2024-01-15", description: "Grocery Store" }
journal_lines:
  debit  Expenses:Groceries     +$85.00
  credit Assets:Checking        -$85.00
  SUM = $0 ✓
```

### Paycheck: $5,850 deposit to Checking
```
journal_entry: { date: "2024-01-14", description: "Payroll Deposit" }
journal_lines:
  debit  Assets:Checking        +$5,850.00
  credit Income:Paychecks       -$5,850.00
  SUM = $0 ✓
```

### Transfer: $500 from Checking to Savings
```
journal_entry: { date: "2024-01-13", description: "Transfer to Savings" }
journal_lines:
  debit  Assets:Savings         +$500.00
  credit Assets:Checking        -$500.00
  SUM = $0 ✓
```
No `is_transfer` flag needed — it's structurally a transfer because both sides are asset accounts.

### Credit card payment: $3,000 from Checking to Credit Card
```
journal_entry: { date: "2024-01-12", description: "Credit Card Payment" }
journal_lines:
  debit  Liabilities:Credit Card  +$3,000.00  (reducing what you owe)
  credit Assets:Checking          -$3,000.00
  SUM = $0 ✓
```

## Net Worth Calculation

```sql
SELECT
  COALESCE(SUM(CASE WHEN a.account_type = 'asset' THEN jl.amount ELSE 0 END), 0) +
  COALESCE(SUM(CASE WHEN a.account_type = 'liability' THEN jl.amount ELSE 0 END), 0)
  AS net_worth
FROM journal_lines jl
JOIN accounts a ON jl.account_id = a.id
WHERE a.household_id = ?;
```

Or more simply: just sum `current_balance` on asset accounts minus `current_balance` on liability accounts (which we'd maintain as a running total from journal lines).

## Spending Query

```sql
-- Total spending this month (only expense accounts)
SELECT a.name, SUM(jl.amount) as total
FROM journal_lines jl
JOIN accounts a ON jl.account_id = a.id
JOIN journal_entries je ON jl.journal_entry_id = je.id
WHERE a.account_type = 'expense'
  AND je.date >= DATE_TRUNC('month', CURRENT_DATE)
  AND a.household_id = ?
GROUP BY a.name
ORDER BY total DESC;
```

Transfers between your own accounts NEVER appear here — they only touch asset/liability accounts.

## Plaid Import Mapping

When Plaid syncs a transaction:
- **Positive amount** (expense): `debit(Expenses:Uncategorized) + credit(Assets:BankAccount)`
- **Negative amount** (income/refund): `debit(Assets:BankAccount) + credit(Income:Uncategorized)`

Category assignment = changing which expense/income account the debit/credit goes to. Same UX as today.

## Migration Strategy

1. Create new tables alongside old ones
2. Migrate data: `financial_accounts` → `accounts` (asset/liability), `categories` → `accounts` (expense/income)
3. Migrate `transactions` → `journal_entries` + `journal_lines` (two lines per transaction)
4. Create `Equity:Opening Balances` account for initial balance snapshots
5. Update all API routes
6. Drop old tables

## What the UI Looks Like

**No change for the user.** They still see:
- Dashboard with net worth, spending
- Transaction list (each journal entry shows as one row)
- Categories (now just expense/income accounts)
- Accounts (asset/liability accounts)

The only visible difference: transfers show cleanly as "Transfer: Checking → Savings" instead of two separate flagged transactions.

## Downsides

- More complex queries (joins through journal_lines)
- Every write is 3 rows instead of 1 (entry + 2 lines)
- Balance snapshots need rethinking (or keep as-is for historical)
- Bigger migration
