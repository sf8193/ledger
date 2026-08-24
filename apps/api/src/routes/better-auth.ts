import { Router, type Router as RouterType } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth';

export const betterAuthRouter: RouterType = Router();

// Better-auth handler - handles all auth routes
// POST /api/auth/sign-up/email
// POST /api/auth/sign-in/email
// POST /api/auth/sign-out
// GET  /api/auth/get-session
// IMPORTANT: This must come LAST as it's a catch-all route
betterAuthRouter.all('/*', toNodeHandler(auth));
