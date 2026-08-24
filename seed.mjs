/**
 * Seed script for Ledger dev/test data.
 * Usage: node seed.mjs [--base http://localhost:5180]
 *
 * Creates a test user with accounts, categories, transactions (categorized + uncategorized),
 * and runs the matchmaker. Idempotent via unique email per run.
 */

const baseArg = process.argv.find(a => a.startsWith('--base='));
const baseIdx = process.argv.indexOf('--base');
const BASE = baseArg ? baseArg.split('=')[1]
  : (baseIdx !== -1 ? process.argv[baseIdx + 1] : 'http://localhost:5180');

const EMAIL = `seed${Date.now()}@test.com`;
const PASSWORD = 'testpassword123';

let cookies = '';

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Origin': BASE,
      ...(cookies && { Cookie: cookies }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Capture set-cookie
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length) {
    cookies = setCookie.map(c => c.split(';')[0]).join('; ');
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${path}: ${text}`);
  }
  return res.json();
}

async function main() {
  console.log(`Seeding against ${BASE} with ${EMAIL}\n`);

  // 1. Register + setup
  await api('/api/auth/sign-up/email', { name: 'Alex', email: EMAIL, password: PASSWORD });
  await api('/api/setup', { name: "Demo Household" });
  console.log('1. User + household created');

  // 2. Accounts
  const checking = await api('/api/accounts', { name: 'Main Checking', account_type: 'asset', initial_balance: 10000 });
  const savings = await api('/api/accounts', { name: 'Savings', account_type: 'asset', initial_balance: 25000 });
  const brokerage = await api('/api/accounts', { name: 'Brokerage', account_type: 'asset', initial_balance: 50000 });
  const ira = await api('/api/accounts', { name: 'Roth IRA', account_type: 'asset', initial_balance: 30000 });
  const credit = await api('/api/accounts', { name: 'Rewards Card', account_type: 'liability', initial_balance: 1500 });
  const mortgage = await api('/api/accounts', { name: 'Home Mortgage', account_type: 'liability', initial_balance: 350000 });
  console.log('2. 6 accounts created');

  // 3. Categories
  const cats = {};
  for (const [name, isIncome] of [
    ['Groceries', false], ['Dining Out', false], ['Subscriptions', false],
    ['Gas & Auto', false], ['Shopping', false], ['Home & Utilities', false],
    ['Healthcare', false], ['Entertainment', false], ['Travel', false],
    ['Childcare', false], ['Personal Care', false], ['Gifts', false],
    ['Salary', true], ['Side Income', true], ['Interest', true],
    ['Uncategorized', false],
  ]) {
    const cat = await api('/api/categories', { name, is_income: isIncome });
    cats[name] = cat.id;
  }
  console.log(`3. ${Object.keys(cats).length} categories created`);

  // 4. Categorized transactions
  const txns = [
    ['GROCERY STORE #10234', 'Fresh Market', 142.87, credit.id, cats['Groceries'], '2026-08-14', 'Jordan'],
    ['GROCERY MART #456', 'Corner Grocery', 68.43, credit.id, cats['Groceries'], '2026-08-12', 'Alex'],
    ['WAREHOUSE CLUB', 'Warehouse Club', 234.56, checking.id, cats['Groceries'], '2026-08-10', 'Shared'],
    ['STREAMING SERVICE', 'StreamCo', 15.99, credit.id, cats['Subscriptions'], '2026-08-13', 'Shared'],
    ['MUSIC APP', 'MusicApp', 10.99, credit.id, cats['Subscriptions'], '2026-08-01', 'Alex'],
    ['SQ *COFFEE SHOP', 'Coffee Shop', 12.50, credit.id, cats['Dining Out'], '2026-08-14', 'Alex'],
    ['FAST CASUAL #2847', 'Quick Bites', 18.75, credit.id, cats['Dining Out'], '2026-08-11', 'Alex'],
    ['GAS STATION 57442', 'Gas Station', 65.40, checking.id, cats['Gas & Auto'], '2026-08-09', 'Alex'],
    ['DAYCARE CENTER', 'Little Stars Daycare', 2800.00, checking.id, cats['Childcare'], '2026-08-01', 'Shared'],
    ['ELECTRIC UTILITY', 'City Electric', 187.32, checking.id, cats['Home & Utilities'], '2026-08-05', 'Shared'],
    ['Employer Direct Dep', 'Employer A', -8500.00, checking.id, cats['Salary'], '2026-08-15', 'Alex'],
    ['Employer Direct Dep', 'Employer B', -6200.00, checking.id, cats['Salary'], '2026-08-15', 'Jordan'],
  ];

  for (const [desc, merchant, amount, acctId, catId, date, owner] of txns) {
    const absAmt = Math.abs(amount);
    const isIncome = amount < 0;
    await api('/api/transactions', {
      date,
      description: desc,
      merchant_name: merchant,
      owner,
      lines: [
        { account_id: catId, amount: isIncome ? -absAmt : absAmt },
        { account_id: acctId, amount: isIncome ? absAmt : -absAmt },
      ],
    });
  }
  console.log(`4. ${txns.length} categorized transactions created`);

  // 5. Uncategorized transactions (will show in review card stack)
  const uncatTxns = [
    ['ONLINE STORE*2K4X1Z3', 'Online Store', 47.99, credit.id, '2026-08-13', 'Alex'],
    ['RIDESHARE *TRIP HJKL', 'Rideshare', 28.45, checking.id, '2026-08-12', 'Jordan'],
    ['TST* ITALIAN RESTAURANT', 'Italian Place', 89.00, credit.id, '2026-08-11', 'Shared'],
    ['APPSTORE/BILL', 'App Store', 9.99, credit.id, '2026-08-08', 'Alex'],
    ['DEPARTMENT STORE #1234', 'Dept Store', 156.78, credit.id, '2026-08-07', 'Jordan'],
  ];

  for (const [desc, merchant, amount, acctId, date, owner] of uncatTxns) {
    await api('/api/transactions', {
      date,
      description: desc,
      merchant_name: merchant,
      owner,
      lines: [
        { account_id: cats['Uncategorized'], amount },
        { account_id: acctId, amount: -amount },
      ],
    });
  }
  console.log(`5. ${uncatTxns.length} uncategorized transactions created`);

  // 6. Transfer pair (for matchmaker to detect)
  await api('/api/transactions', {
    date: '2026-08-10',
    description: 'Transfer to Savings',
    merchant_name: null,
    lines: [
      { account_id: cats['Uncategorized'], amount: 2000 },
      { account_id: checking.id, amount: -2000 },
    ],
  });
  await api('/api/transactions', {
    date: '2026-08-10',
    description: 'Transfer from Checking',
    merchant_name: null,
    lines: [
      { account_id: cats['Uncategorized'], amount: 2000 },
      { account_id: savings.id, amount: -2000 },
    ],
  });
  console.log('6. Transfer pair created');

  // 7. Run matchmaker
  const matchResult = await api('/api/matching/run', {});
  console.log(`7. Matchmaker: ${JSON.stringify(matchResult)}`);

  console.log(`\nDone! Login with ${EMAIL} / ${PASSWORD}`);
  console.log(`Dashboard: ${BASE}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
