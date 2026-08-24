import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { sql } from 'kysely';
import { asyncHandler } from '../middleware/error';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dashboardRouter: RouterType = Router();

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;

  const [accountBalances, recentEntries, monthlySpending, monthlyIncome, pendingReimbursements] = await Promise.all([
    // Net worth from the LEDGER — the single source of truth
    db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.is_hidden', '=', false)
      .where('a.account_type', 'in', ['asset', 'liability'])
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .groupBy(['a.id', 'a.name', 'a.account_type'])
      .select([
        'a.id',
        'a.name',
        'a.account_type',
        sql<number>`SUM(jl.amount)`.as('balance'),
      ])
      .execute(),

    // Recent journal entries with display amount (max absolute line amount per entry)
    db.selectFrom('journal_entries as je')
      .leftJoin('journal_lines as jl2', 'jl2.journal_entry_id', 'je.id')
      .leftJoin('accounts as a2', 'a2.id', 'jl2.account_id')
      .where('je.household_id', '=', householdId)
      .where('je.source', '!=', 'plaid_reconciliation')
      .groupBy(['je.id', 'je.date', 'je.description', 'je.merchant_name', 'je.owner', 'je.source'])
      .orderBy('je.date', 'desc')
      .limit(10)
      .select([
        'je.id',
        'je.date',
        'je.description',
        'je.merchant_name',
        'je.owner',
        'je.source',
        // Display amount: the expense/income line amount, or max absolute amount
        sql<number>`MAX(CASE WHEN a2.account_type IN ('expense', 'income') THEN jl2.amount END)`.as('amount'),
      ])
      .execute(),

    // Monthly spending (net on expense accounts — includes refund credits)
    // Uses net SUM so refunds correctly reduce spending
    db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE)`)
      .select(sql<number>`GREATEST(COALESCE(SUM(jl.amount), 0), 0)`.as('total'))
      .executeTakeFirst(),

    // Monthly income (net on income accounts — includes reclassification debits)
    // Uses net SUM (not just credits) so reclassification entries correctly reduce income
    db.selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'income')
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false)
      .where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE)`)
      .select(sql<number>`GREATEST(COALESCE(-SUM(jl.amount), 0), 0)`.as('total'))
      .executeTakeFirst(),

    // Pending reimbursement total
    db.selectFrom('journal_entries as je')
      .innerJoin('journal_lines as jl', 'jl.journal_entry_id', 'je.id')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .where('je.household_id', '=', householdId)
      .where('je.reimbursement_status', '=', 'pending')
      .where('a.account_type', '=', 'expense')
      .where('jl.amount', '>', 0)
      .select(sql<number>`COALESCE(SUM(jl.amount), 0)`.as('total'))
      .executeTakeFirst(),
  ]);

  // Net worth headline: use the BETTER of snapshot or journal per account.
  // - Snapshot-only accounts (no Plaid connection): use snapshot (e.g. Monarch brokerage history)
  // - Journal-only accounts (no snapshots): use journal (e.g. mortgages)
  // - Accounts with BOTH: use journal if there are recent Plaid transactions,
  //   otherwise use snapshot. Journal balance from Plaid is the live balance.
  //   Snapshot may be stale (from Monarch export date).
  const latestSnapshots = await db
    .selectFrom('balance_snapshots as bs')
    .innerJoin('accounts as a', 'a.id', 'bs.account_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', 'in', ['asset', 'liability'])
    .where('a.is_hidden', '=', false)
    .where('bs.date', '=', (eb: any) =>
      eb.selectFrom('balance_snapshots as bs2')
        .whereRef('bs2.account_id', '=', 'bs.account_id')
        .select(eb.fn.max('bs2.date').as('d'))
    )
    .select(['a.id', 'a.account_type', 'bs.balance'])
    .execute();

  const snapshotById = new Map(latestSnapshots.map(s => [s.id, s]));
  const journalById = new Map(accountBalances.map(a => [a.id, a]));
  const allIds = new Set([...snapshotById.keys(), ...journalById.keys()]);

  let netWorth = 0;
  for (const id of allIds) {
    const snap = snapshotById.get(id);
    const journal = journalById.get(id);

    if (journal && snap) {
      // Account has both — use whichever has the larger absolute value.
      // Plaid-connected accounts have meaningful journal balances.
      // Monarch-only accounts have $0 or small journal balances from opening entries.
      const jBal = Number(journal.balance);
      const sBal = snap.account_type === 'liability' ? -Number(snap.balance) : Number(snap.balance);
      netWorth += Math.abs(jBal) >= Math.abs(sBal) ? jBal : sBal;
    } else if (snap) {
      // Snapshot only (no journal entries) — use snapshot
      netWorth += snap.account_type === 'liability' ? -Number(snap.balance) : Number(snap.balance);
    } else if (journal) {
      // Journal only — use journal
      netWorth += Number(journal.balance);
    }
  }

  res.json({
    netWorth,
    accountCount: accountBalances.length,
    monthlySpending: Number(monthlySpending?.total) || 0,
    monthlyIncome: Number(monthlyIncome?.total) || 0,
    pendingReimbursements: Number(pendingReimbursements?.total) || 0,
    recentEntries,
  });
}));

// Net worth history from the LEDGER — the single source of truth
// Computes cumulative sum of asset+liability journal lines by date
dashboardRouter.get('/nlv-history', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;

  // Accounts with balance snapshots use snapshot data (investment/brokerage).
  // Accounts without snapshots use cumulative journal_lines (checking/credit cards).
  const snapshotAccounts = await db
    .selectFrom('balance_snapshots as bs')
    .innerJoin('accounts as a', 'a.id', 'bs.account_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', 'in', ['asset', 'liability'])
    .where('a.is_hidden', '=', false)
    .select('a.id')
    .groupBy('a.id')
    .execute();

  const snapshotAccountIds = new Set(snapshotAccounts.map(a => a.id));

  // 1. Snapshot-based accounts: per-account per-day balances, forward-filled
  //    We need each account's balance on each date, using last known value
  const rawSnapshots = snapshotAccountIds.size > 0
    ? await db
        .selectFrom('balance_snapshots as bs')
        .innerJoin('accounts as a', 'a.id', 'bs.account_id')
        .where('a.household_id', '=', householdId)
        .where('a.id', 'in', [...snapshotAccountIds])
        .orderBy('bs.date', 'asc')
        .select([
          'bs.date',
          'bs.account_id',
          'bs.balance',
          'a.account_type',
        ])
        .execute()
    : [];

  // Build per-account balance timeline, then compute daily totals with forward-fill
  const accountBalances = new Map<string, { balance: number; sign: number }>();
  const snapshotDailyTotals = new Map<string, number>();

  // Initialize sign multiplier per account (liabilities subtract)
  const accountSigns = new Map<string, number>();
  for (const r of rawSnapshots) {
    if (!accountSigns.has(r.account_id)) {
      accountSigns.set(r.account_id, r.account_type === 'liability' ? -1 : 1);
    }
  }

  // Process snapshots in date order, forward-filling per account
  for (const r of rawSnapshots) {
    const dateStr = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    const sign = accountSigns.get(r.account_id) || 1;
    accountBalances.set(r.account_id, { balance: Number(r.balance), sign });

    // Recompute total from all known account balances
    let total = 0;
    for (const [, { balance, sign: s }] of accountBalances) {
      total += balance * s;
    }
    snapshotDailyTotals.set(dateStr, total);
  }

  const snapshotRows = [...snapshotDailyTotals.entries()].map(([date, total]) => ({ date, total }));

  // 2. Journal-based accounts: cumulative sum (exclude snapshot accounts)
  let journalQuery = db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', 'in', ['asset', 'liability'])
    .where('a.is_hidden', '=', false)
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false);

  if (snapshotAccountIds.size > 0) {
    journalQuery = journalQuery.where('a.id', 'not in', [...snapshotAccountIds]);
  }

  const journalRows = await journalQuery
    .groupBy('je.date')
    .orderBy('je.date', 'asc')
    .select([
      'je.date',
      sql<number>`SUM(SUM(jl.amount)) OVER (ORDER BY je.date)`.as('net_worth'),
    ])
    .execute();

  // 3. Merge: for each date, combine snapshot total + journal cumulative
  const snapshotByDate = new Map<string, number>();
  for (const r of snapshotRows) {
    snapshotByDate.set(r.date, r.total);
  }

  const journalByDate = new Map<string, number>();
  for (const r of journalRows) {
    const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    journalByDate.set(d, Number(r.net_worth));
  }

  // Collect all dates from both sources
  const allDates = [...new Set([...snapshotByDate.keys(), ...journalByDate.keys()])].sort();

  // Forward-fill: carry last known values for dates where only one source has data
  let lastSnapshot = 0;
  let lastJournal = 0;
  const history = allDates.map(date => {
    if (snapshotByDate.has(date)) lastSnapshot = snapshotByDate.get(date)!;
    if (journalByDate.has(date)) lastJournal = journalByDate.get(date)!;
    return { date, netWorth: lastSnapshot + lastJournal };
  });

  res.json({ history });
}));

// Monthly spending breakdown by category (expense accounts)
// Groups by month + category, optional owner filter
dashboardRouter.get('/spending-breakdown', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const months = Math.min(Math.max(parseInt(req.query.months as string) || 6, 1), 24);
  const owner = req.query.owner as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'Invalid from date format (YYYY-MM-DD)' });
  if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'Invalid to date format (YYYY-MM-DD)' });

  let query = db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'expense')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false);

  // Custom date range overrides months param
  if (from) {
    query = query.where('je.date', '>=', sql<Date>`${from}::date`);
  } else {
    query = query.where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE) - make_interval(months => ${months - 1})`);
  }
  if (to) {
    query = query.where('je.date', '<=', sql<Date>`${to}::date`);
  }

  if (owner) {
    query = query.where('je.owner', '=', owner);
  }

  const rows = await query
    .groupBy([sql`TO_CHAR(je.date, 'YYYY-MM')`, 'a.id', 'a.name'])
    .orderBy(sql`TO_CHAR(je.date, 'YYYY-MM')`, 'asc')
    .select([
      sql<string>`TO_CHAR(je.date, 'YYYY-MM')`.as('month'),
      'a.id as category_id',
      'a.name as category_name',
      sql<number>`SUM(jl.amount)`.as('amount'),
    ])
    .execute();

  // Get distinct owners and all expense categories for stable color assignment
  const [owners, allCategories] = await Promise.all([
    db.selectFrom('journal_entries as je')
      .where('je.household_id', '=', householdId)
      .where('je.owner', 'is not', null)
      .select(sql<string>`DISTINCT je.owner`.as('owner'))
      .execute(),
    db.selectFrom('accounts as a')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'expense')
      .orderBy('a.name', 'asc')
      .select(['a.id', 'a.name'])
      .execute(),
  ]);

  res.json({
    breakdown: rows.map(r => ({
      month: r.month,
      categoryId: r.category_id,
      categoryName: r.category_name,
      amount: Number(r.amount),
    })),
    owners: owners.map(o => o.owner),
    allCategories: allCategories.map(c => c.name),
  });
}));

// Monthly income breakdown by category (income accounts)
// Mirror of spending-breakdown but for income, with amounts negated (credits → positive)
dashboardRouter.get('/income-breakdown', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const months = Math.min(Math.max(parseInt(req.query.months as string) || 6, 1), 24);
  const owner = req.query.owner as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'Invalid from date format (YYYY-MM-DD)' });
  if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'Invalid to date format (YYYY-MM-DD)' });

  let query = db
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', '=', 'income')
    .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false);

  if (from) {
    query = query.where('je.date', '>=', sql<Date>`${from}::date`);
  } else {
    query = query.where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE) - make_interval(months => ${months - 1})`);
  }
  if (to) {
    query = query.where('je.date', '<=', sql<Date>`${to}::date`);
  }
  if (owner) {
    query = query.where('je.owner', '=', owner);
  }

  const rows = await query
    .groupBy([sql`TO_CHAR(je.date, 'YYYY-MM')`, 'a.id', 'a.name'])
    .orderBy(sql`TO_CHAR(je.date, 'YYYY-MM')`, 'asc')
    .select([
      sql<string>`TO_CHAR(je.date, 'YYYY-MM')`.as('month'),
      'a.id as category_id',
      'a.name as category_name',
      // Negate: income credits are negative in the ledger
      sql<number>`-SUM(jl.amount)`.as('amount'),
    ])
    .execute();

  const [owners, allCategories] = await Promise.all([
    db.selectFrom('journal_entries as je')
      .where('je.household_id', '=', householdId)
      .where('je.owner', 'is not', null)
      .select(sql<string>`DISTINCT je.owner`.as('owner'))
      .execute(),
    db.selectFrom('accounts as a')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', 'income')
      .orderBy('a.name', 'asc')
      .select(['a.id', 'a.name'])
      .execute(),
  ]);

  res.json({
    breakdown: rows.map(r => ({
      month: r.month,
      categoryId: r.category_id,
      categoryName: r.category_name,
      amount: Number(r.amount),
    })),
    owners: owners.map(o => o.owner),
    allCategories: allCategories.map(c => c.name),
  });
}));

// Cash flow: monthly income vs expenses with savings
dashboardRouter.get('/cashflow', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const months = Math.min(Math.max(parseInt(req.query.months as string) || 12, 1), 36);
  const owner = req.query.owner as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'Invalid from date format (YYYY-MM-DD)' });
  if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'Invalid to date format (YYYY-MM-DD)' });

  // Build shared WHERE conditions for income and expense queries
  const buildQuery = (accountType: 'income' | 'expense') => {
    let query = db
      .selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', accountType)
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false);

    if (from) {
      query = query.where('je.date', '>=', sql<Date>`${from}::date`);
    } else {
      query = query.where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE) - make_interval(months => ${months - 1})`);
    }
    if (to) {
      query = query.where('je.date', '<=', sql<Date>`${to}::date`);
    }
    if (owner) {
      query = query.where('je.owner', '=', owner);
    }

    return query
      .groupBy(sql`TO_CHAR(je.date, 'YYYY-MM')`)
      .orderBy(sql`TO_CHAR(je.date, 'YYYY-MM')`, 'asc')
      .select([
        sql<string>`TO_CHAR(je.date, 'YYYY-MM')`.as('month'),
        sql<number>`SUM(jl.amount)`.as('total'),
      ]);
  };

  const [incomeRows, expenseRows, owners] = await Promise.all([
    buildQuery('income').execute(),
    buildQuery('expense').execute(),
    db.selectFrom('journal_entries as je')
      .where('je.household_id', '=', householdId)
      .where('je.owner', 'is not', null)
      .select(sql<string>`DISTINCT je.owner`.as('owner'))
      .execute(),
  ]);

  // Merge into a single month-indexed result
  // Income credits are negative in the ledger, negate to get positive values
  // Expense debits are positive in the ledger
  const incomeMap = new Map(incomeRows.map(r => [r.month, -Number(r.total)]));
  const expenseMap = new Map(expenseRows.map(r => [r.month, Number(r.total)]));
  const allMonths = [...new Set([...incomeMap.keys(), ...expenseMap.keys()])].sort();

  const data = allMonths.map(month => {
    const income = incomeMap.get(month) ?? 0;
    const expenses = expenseMap.get(month) ?? 0;
    return { month, income, expenses, savings: income - expenses };
  });

  const totalIncome = data.reduce((s, d) => s + d.income, 0);
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0);

  res.json({
    data,
    totalIncome,
    totalExpenses,
    savings: totalIncome - totalExpenses,
    owners: owners.map(o => o.owner),
  });
}));

// Sankey flow: income sources → savings/spending → expense categories
dashboardRouter.get('/sankey', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;
  const months = Math.min(Math.max(parseInt(req.query.months as string) || 12, 1), 36);
  const owner = req.query.owner as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'Invalid from date format (YYYY-MM-DD)' });
  if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'Invalid to date format (YYYY-MM-DD)' });

  const buildQuery = (accountType: 'income' | 'expense') => {
    let query = db
      .selectFrom('journal_lines as jl')
      .innerJoin('accounts as a', 'a.id', 'jl.account_id')
      .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
      .where('a.household_id', '=', householdId)
      .where('a.account_type', '=', accountType)
      .where(sql`COALESCE(je.exclude_from_totals, a.exclude_from_totals, false)`, '=', false);

    if (from) {
      query = query.where('je.date', '>=', sql<Date>`${from}::date`);
    } else {
      query = query.where('je.date', '>=', sql<Date>`DATE_TRUNC('month', CURRENT_DATE) - make_interval(months => ${months - 1})`);
    }
    if (to) {
      query = query.where('je.date', '<=', sql<Date>`${to}::date`);
    }
    if (owner) {
      query = query.where('je.owner', '=', owner);
    }

    return query
      .groupBy(['a.id', 'a.name'])
      .select([
        'a.name',
        sql<number>`SUM(jl.amount)`.as('total'),
      ]);
  };

  const [incomeRows, expenseRows] = await Promise.all([
    buildQuery('income').execute(),
    buildQuery('expense').execute(),
  ]);

  // Build nodes and links
  // Income amounts are negative credits — negate. Expense amounts are positive debits.
  const incomeSources = incomeRows
    .map(r => ({ name: r.name, amount: -Number(r.total) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const expenseCategories = expenseRows
    .map(r => ({ name: r.name, amount: Number(r.total) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const totalIncome = incomeSources.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenseCategories.reduce((s, r) => s + r.amount, 0);
  const savings = totalIncome - totalExpenses;

  // Nodes: income sources, then "Spending" hub, optionally "Savings", then expense categories
  const nodes: Array<{ name: string }> = [];
  const links: Array<{ source: number; target: number; value: number }> = [];

  // Add income source nodes
  for (const src of incomeSources) {
    nodes.push({ name: src.name });
  }

  // Add hub nodes
  const spendingIdx = nodes.length;
  nodes.push({ name: 'Spending' });

  let savingsIdx = -1;
  if (savings > 0) {
    savingsIdx = nodes.length;
    nodes.push({ name: 'Savings' });
  }

  // Add expense category nodes
  const expenseStartIdx = nodes.length;
  for (const cat of expenseCategories) {
    nodes.push({ name: cat.name });
  }

  // Links: income → spending hub (and savings if positive)
  for (let i = 0; i < incomeSources.length; i++) {
    const src = incomeSources[i];
    if (totalIncome > 0) {
      // Split each income source proportionally into spending + savings
      const spendingShare = totalExpenses > 0 ? src.amount * (totalExpenses / totalIncome) : 0;
      const savingsShare = savings > 0 ? src.amount * (savings / totalIncome) : 0;

      if (spendingShare > 0) {
        links.push({ source: i, target: spendingIdx, value: Math.round(spendingShare * 100) / 100 });
      }
      if (savingsShare > 0 && savingsIdx >= 0) {
        links.push({ source: i, target: savingsIdx, value: Math.round(savingsShare * 100) / 100 });
      }
    }
  }

  // Links: spending hub → expense categories
  for (let i = 0; i < expenseCategories.length; i++) {
    links.push({ source: spendingIdx, target: expenseStartIdx + i, value: expenseCategories[i].amount });
  }

  res.json({ nodes, links });
}));

// Account balances from the ledger — the single source of truth
dashboardRouter.get('/balances', asyncHandler(async (req, res) => {
  const householdId = req.householdId!;

  // All asset/liability accounts, with ledger balance computed from non-excluded entries
  const balanceRows = await db
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', 'je.id', 'jl.journal_entry_id')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .where('a.household_id', '=', householdId)
    .where('a.account_type', 'in', ['asset', 'liability'])
    .where(sql`COALESCE(je.exclude_from_totals, false)`, '=', false)
    .groupBy(['a.id', 'a.name', 'a.account_type', 'a.is_hidden'])
    .select([
      'a.id',
      'a.name',
      'a.account_type',
      'a.is_hidden',
      sql<number>`COALESCE(SUM(jl.amount), 0)`.as('ledger_balance'),
    ])
    .execute();

  // Also include accounts with zero entries (no journal lines yet)
  const allAccounts = await db
    .selectFrom('accounts')
    .where('household_id', '=', householdId)
    .where('account_type', 'in', ['asset', 'liability'])
    .select(['id', 'name', 'account_type', 'is_hidden'])
    .execute();

  const balanceMap = new Map(balanceRows.map(r => [r.id, Number(r.ledger_balance)]));
  const results = allAccounts.map(a => ({
    ...a,
    ledger_balance: balanceMap.get(a.id) ?? 0,
  }));

  res.json({
    accounts: results.map(r => ({
      id: r.id,
      name: r.name,
      account_type: r.account_type,
      is_hidden: r.is_hidden,
      balance: Number(r.ledger_balance),
    })),
  });
}));
