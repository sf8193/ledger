import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';

export const fireRouter: RouterType = Router();

// --- Scenarios ---

fireRouter.get('/scenarios', asyncHandler(async (req, res) => {
  const scenarios = await db.selectFrom('fire_scenarios')
    .where('household_id', '=', req.householdId!)
    .orderBy('created_at', 'desc')
    .selectAll()
    .execute();
  res.json(scenarios);
}));

const scenarioSchema = z.object({
  name: z.string().min(1).max(200),
  inputs: z.record(z.string(), z.any()),
});

fireRouter.post('/scenarios', asyncHandler(async (req, res) => {
  const data = scenarioSchema.parse(req.body);
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insertInto('fire_scenarios').values({
    id,
    household_id: req.householdId!,
    name: data.name,
    inputs: JSON.stringify(data.inputs),
    created_at: now,
    updated_at: now,
  }).execute();
  res.status(201).json({ id, name: data.name, inputs: data.inputs, created_at: now, updated_at: now });
}));

fireRouter.put('/scenarios/:id', asyncHandler(async (req, res) => {
  const data = scenarioSchema.parse(req.body);
  const updated = await db.updateTable('fire_scenarios')
    .set({
      name: data.name,
      inputs: JSON.stringify(data.inputs),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .returningAll()
    .executeTakeFirst();
  if (!updated) return res.status(404).json({ error: 'Scenario not found' });
  res.json(updated);
}));

fireRouter.delete('/scenarios/:id', asyncHandler(async (req, res) => {
  const result = await db.deleteFrom('fire_scenarios')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .executeTakeFirst();
  if (!result.numDeletedRows) return res.status(404).json({ error: 'Scenario not found' });
  res.json({ ok: true });
}));

// --- Settings ---

fireRouter.get('/settings', asyncHandler(async (req, res) => {
  const row = await db.selectFrom('fire_settings')
    .where('household_id', '=', req.householdId!)
    .selectAll()
    .executeTakeFirst();
  res.json(row?.settings ?? {});
}));

const settingsSchema = z.object({
  currentAge: z.number().int().min(1).max(120).optional(),
  retirementAge: z.number().int().min(1).max(120).optional(),
  nominalReturn: z.number().min(-50).max(100).optional(),
  inflation: z.number().min(-20).max(50).optional(),
  swr: z.number().min(0.1).max(20).optional(),
  stockAllocation: z.number().int().min(0).max(100).optional(),
  timelineEvents: z.array(z.object({
    id: z.string(),
    label: z.string(),
    age: z.number(),
    annualAmount: z.number(),
    type: z.enum(['income', 'expense_reduction']),
  })).optional(),
  socialSecurity: z.object({
    enabled: z.boolean(),
    monthlyBenefitAt67: z.number().min(0),
    claimingAge: z.number().int().min(62).max(70),
  }).optional(),
}).passthrough(); // allow unknown keys for forward compat

fireRouter.put('/settings', asyncHandler(async (req, res) => {
  const settings = settingsSchema.parse(req.body);
  const now = new Date().toISOString();
  const householdId = req.householdId!;

  // Upsert
  const existing = await db.selectFrom('fire_settings')
    .where('household_id', '=', householdId)
    .select('household_id')
    .executeTakeFirst();

  if (existing) {
    await db.updateTable('fire_settings')
      .set({ settings: JSON.stringify(settings), updated_at: now })
      .where('household_id', '=', householdId)
      .execute();
  } else {
    await db.insertInto('fire_settings').values({
      household_id: householdId,
      settings: JSON.stringify(settings),
      updated_at: now,
    }).execute();
  }

  res.json({ ok: true });
}));
