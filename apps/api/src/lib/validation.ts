import { z } from 'zod';

export const plaidExchangeSchema = z.object({
  public_token: z.string().min(1),
  institution: z.object({
    institution_id: z.string().max(100).optional(),
    name: z.string().max(200).optional(),
  }).optional(),
  accounts: z.array(z.object({
    id: z.string(),
    name: z.string().max(200),
    mask: z.string().max(10).nullable().optional(),
  })).optional(),
});
