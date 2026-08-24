import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from './middleware/auth';
import { householdMiddleware } from './middleware/household';
import { errorHandler } from './middleware/error';
import { betterAuthRouter } from './routes/better-auth';
import { authRouter } from './routes/auth';
import { accountsRouter } from './routes/accounts';
import { transactionsRouter } from './routes/transactions';
import { categoriesRouter } from './routes/categories';
import { dashboardRouter } from './routes/dashboard';
import { plaidRouter } from './routes/plaid';
import { importRouter } from './routes/import';
import { reimbursementsRouter } from './routes/reimbursements';
import { matchingRouter } from './routes/matching';
import { budgetsRouter } from './routes/budgets';
import { householdsRouter } from './routes/households';
import { webhookRouter } from './routes/webhook';
import { fireRouter } from './routes/fire';
import { taxesRouter } from './routes/taxes';
import { startSyncCron, stopSyncCron } from './services/cron';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { requestLogger } from './middleware/request-logger';

const app = express();
const PORT = process.env.PORT || 4100;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5180',
  credentials: true,
  maxAge: 86400,
}));

// Capture raw body for webhook signature verification
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => {
    (req as Express.Request).rawBody = buf.toString();
  },
}));
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '30'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Request logging
app.use(requestLogger);

// Health check — verifies DB is reachable
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
  }
});

// Better Auth handler (public, rate-limited)
app.use('/api/auth', authLimiter, betterAuthRouter);

// Plaid webhooks (public — no auth, Plaid sends these directly)
app.use('/api/webhook', webhookRouter);

// Setup route (household creation after registration)
app.use('/api', authRouter);

// Protected routes
app.use('/api/dashboard', authMiddleware, householdMiddleware, dashboardRouter);
app.use('/api/accounts', authMiddleware, householdMiddleware, accountsRouter);
app.use('/api/transactions', authMiddleware, householdMiddleware, transactionsRouter);
app.use('/api/categories', authMiddleware, householdMiddleware, categoriesRouter);
app.use('/api/plaid', authMiddleware, householdMiddleware, plaidRouter);
app.use('/api/import', authMiddleware, householdMiddleware, importRouter);
app.use('/api/reimbursements', authMiddleware, householdMiddleware, reimbursementsRouter);
app.use('/api/matching', authMiddleware, householdMiddleware, matchingRouter);
app.use('/api/budgets', authMiddleware, householdMiddleware, budgetsRouter);
app.use('/api/households', authMiddleware, householdsRouter);
app.use('/api/fire', authMiddleware, householdMiddleware, fireRouter);
app.use('/api/taxes', authMiddleware, householdMiddleware, taxesRouter);

// Global error handler — must be after all routes
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, `Ledger API running on port ${PORT}`);
  startSyncCron();
});

function shutdown() {
  logger.info('Shutting down...');
  stopSyncCron();
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
