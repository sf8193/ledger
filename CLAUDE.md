# Ledger — Self-Hosted Personal Finance App

Double-entry accounting, Plaid bank sync, Monarch import, built for a family.

## Wiki

When starting a new task, read `wiki/index.md` (if present) for full context on architecture, accounting model, review decisions, and backlog.

## Quick Start

```bash
cd apps/api && make start-db   # Postgres on port 5434
pnpm dev                       # API on 4100, Web on 5180
```

## Local Infrastructure

- **Database**: Postgres 17 in Docker on port 5434. Runs via `docker-compose.yml` at repo root, or `make start-db` in `apps/api/`.
- **Playwright**: Available for screenshot tests. Scripts like `screenshot.mjs`, `screenshot-flow.mjs` register a user via in-page `fetch()` calls (not direct API calls) to get auth cookies on the right origin.

## Architecture

```
Plaid (bank data) → API (Express + Kysely + Postgres) → Web (Vite + React)
                         ↓
                   Double-entry ledger
                   (journal_entries + journal_lines, zero-sum trigger)
                         ↓
                   Dashboard (net worth, spending)
```

## Directory Reference

| Directory | Purpose |
|-----------|---------|
| `apps/api/` | Express API, Kysely, Postgres, Better Auth, Plaid |
| `apps/api/migrations/` | SQL migrations |
| `apps/api/src/routes/` | accounts, transactions, categories, dashboard, plaid, import, webhook, reimbursements, matching |
| `apps/api/src/services/` | sync (Plaid sync engine), matchmaker (auto-categorize + transfer detection), cron |
| `apps/api/src/__tests__/` | Behavioral tests (vitest) |
| `apps/web/` | Vite + React frontend, Tailwind dark theme |
| `apps/web/src/pages/` | Dashboard, Accounts, Transactions, Categories, Import, Review, Settings |
| `apps/web/src/components/` | Layout (icon sidebar), PlaidLink, ReviewCardStack (tinder-style card dismiss) |
| `wiki/` | Project wiki — philosophy, architecture, decisions |
| `data/` | Monarch CSV exports (gitignored) |

## Ports

| Service | Port |
|---------|------|
| API | 4100 |
| Web | 5180 |
| DB | 5434 |

## Key Commands

```bash
cd apps/api && make start-db          # Start Postgres
cd apps/api && make reset-db          # Drop + recreate DB
cd apps/api && pnpm run migrate       # Run migrations
cd apps/api && pnpm test              # Run tests
cd apps/api && npx tsc --noEmit       # Type check
pnpm dev                              # Start API + Web
```

## Core Principle

**The ledger is the single source of truth.** Every balance change creates a journal entry. All reads compute from `SUM(journal_lines.amount)`. There is no cache — `current_balance` column was dropped. See `wiki/articles/review-decisions.md` for the full rationale.

## Invariants

1. **Journal entries are immutable facts.** Never update amounts on a journal entry. To correct, supersede the old entry (`superseded_by`, `exclude_from_totals = true`) and create a new one.
2. **Pending transactions live in staging, not the journal.** `pending_transactions` table holds mutable Plaid pending items. They're promoted to journal entries only when cleared (`pending: false`). Net worth is computed from the ledger only — pending items can't cause spikes.
3. **Removed transactions are soft-deleted.** Plaid `removed` events set `exclude_from_totals = true` + `source = 'plaid_removed'` on the journal entry. Never hard-delete a settled journal entry.
4. **Reconciliation creates new entries, never mutates.** Same-day recon updates supersede the previous entry via the `superseded_by` pattern. Full audit trail preserved.
5. **Balance queries filter excluded entries.** Every `SUM(journal_lines.amount)` must join through `journal_entries` and filter `WHERE COALESCE(exclude_from_totals, false) = false`.

## Seed Data

```bash
node seed.mjs                              # seed against localhost:5180 (default)
node seed.mjs --base=http://localhost:5180  # explicit base URL
```

Creates a test user with 6 accounts (checking, savings, brokerage, IRA, credit card, mortgage), 16 categories, 12 categorized transactions, 5 uncategorized, 1 transfer pair, and runs the matchmaker. Prints login credentials at the end. Each run creates a fresh user (unique email).

## Build & Test

```bash
cd apps/api && pnpm test              # Behavioral tests (vitest)
cd apps/api && npx tsc --noEmit       # Type check
node screenshot-flow.mjs              # Playwright visual test
```

Compile-check AND test before committing. Tests run against a real Postgres DB (`ledger_test` on port 5434).

## Key Conventions

- One concern per commit. Split correctness from capability.
- `||` at system boundaries (env reads, user input), `??` internally.
- Every write path that creates journal entries needs a test.
- New features include regression tests for bugs found in review.
- No daemon-internal or cross-package imports that create cycles.

### What to test for
- **Sign conventions:** asset debit = positive, liability credit = negative
- **Spending isolation:** transfers and CC payments never appear as spending
- **Cross-tenant:** validate all account_ids belong to the household before writing
- **Dedup:** re-import doesn't create duplicates
- **Zero-sum:** every journal entry's lines sum to exactly $0.00

### Code standards
- All account inserts: no `current_balance` field (column dropped)
- All balance reads: `SUM(journal_lines.amount)` grouped by account
- All journal writes: inside `db.transaction()` for atomicity
- Equity account lookups: filter by `name = 'Opening Balances'` not just type
- Category validation: check `account_type IN ('expense', 'income')` on reassignment
- Household scoping: every query that touches `journal_lines` must join through `journal_entries.household_id` or `accounts.household_id`
- `balance_snapshots` queries MUST join through `accounts` for household scoping (layer 2 landmine)

### Accounting rules
- Positive journal line = debit, negative = credit
- Assets: debit (+) increases balance, credit (-) decreases
- Liabilities: credit (-) increases what you owe, debit (+) decreases
- Income: credit (-) is normal (money earned)
- Expenses: debit (+) is normal (money spent)
- Every entry must sum to zero (enforced by DB trigger)
- Transfers are asset↔asset or asset↔liability — never touch expense accounts
- Residuals (unexplained balance changes) go to `Income:Unclassified Adjustments`
- Opening balances go to `Equity:Opening Balances`
- Unmatched transfers go to `Equity:Suspense`
- Pending transactions are NOT in the journal — they live in `pending_transactions` staging table
- Reconciliation adjusts Plaid balance by pending amounts before computing residual (sign-aware per account type)
- Removed transactions use soft-delete (`exclude_from_totals`, `source = 'plaid_removed'`), never hard-delete

## Git Workflow

Simple `main` branch for now. Commits include `Co-Authored-By: Claude` tag.
