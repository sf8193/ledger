import { Request, Response, NextFunction } from 'express';
import { auth } from '../lib/auth';
import { logger } from '../lib/logger';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers as Record<string, string | string[] | undefined>,
    });

    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.auth = {
      userId: session.user.id,
      sessionId: session.session.id,
    };

    next();
  } catch (error) {
    logger.error({ err: error }, 'Auth error');
    res.status(401).json({ error: 'Invalid session' });
  }
};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        sessionId: string;
      };
      rawBody?: string;
      reqId?: string;
    }
  }
}
