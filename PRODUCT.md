# Ledger — Product Context

## Product Purpose
Self-hosted personal finance app for a family. Replaces Monarch Money with something owned, customizable, and potentially sellable as a SaaS product down the line. Tracks net worth, spending, income, bank accounts, and investment holdings across a household.

## Users
- **Primary:** A couple with two incomes and kids. They want to see where money goes, track net worth over time, and manage reimbursements between personal/shared expenses.
- **Secondary (future):** Other households if this becomes a product. Multi-tenant from day one.

## Register
product

## Brand / Tone
- **Calm authority.** This is a financial tool — it should feel trustworthy and precise, not playful.
- **Dark, quiet, information-dense.** Users glance at this weekly, not hourly. Dense is good when the data is clear.
- **Emerald primary.** Money = green. Not flashy neon green — muted, confident emerald.
- **No gamification.** No streaks, badges, confetti (the "all caught up" sparkle is borderline — keep it subtle). This isn't a game.

## Anti-References
- Mint's cluttered ad-filled UI
- Robinhood's candy-colored gamification
- Generic SaaS cream/white with blue accent
- Navy-and-gold "premium fintech" aesthetic
- Neon-on-black crypto aesthetic

## Design System Origin
Shares: narrow icon sidebar, CSS variable tokens, card elevation system, dark surface hierarchy, animation keyframes, scrollbar styling. Diverges on primary color (emerald vs blue) and content type (data entry/review vs monitoring).

## Key Surfaces
1. **Dashboard** — net worth, spending, income stats; review banner; recent activity
2. **Review card stack** — tinder-style categorization of uncategorized transactions and transfer matching
3. **Transactions** — journal entry list with owner attribution, search, category display
4. **Accounts** — grouped by type (asset/liability), ledger-computed balances
5. **Import** — Monarch CSV upload
6. **Settings** — Plaid bank connections

## Strategic Principles
- The ledger is the single source of truth. UI reflects computed state, never cached values.
- Household-scoped. Every query, every display. No data leaks between tenants.
- Review workflow is the core loop: import/sync → categorize → done. Make this fast.
