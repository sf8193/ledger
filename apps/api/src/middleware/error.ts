import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

// Wrap async route handlers to catch rejections
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Global error handler — must be registered after all routes
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // Postgres constraint violations are expected — log at warn
  if (err.code === '23505') {
    logger.warn({ err, reqId: req.reqId }, 'Duplicate entry');
    res.status(409).json({ error: 'Duplicate entry' });
    return;
  }

  if (err.code === '23503') {
    logger.warn({ err, reqId: req.reqId }, 'FK violation');
    res.status(400).json({ error: 'Referenced record not found' });
    return;
  }

  // Everything else is unexpected
  logger.error({ err, reqId: req.reqId, path: req.originalUrl }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
