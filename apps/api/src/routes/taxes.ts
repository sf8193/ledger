import { Router, type Router as RouterType } from 'express';
import { db } from '../db/kysely';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../middleware/error';
import { z } from 'zod';

export const taxesRouter: RouterType = Router();

taxesRouter.get('/scenarios', asyncHandler(async (req, res) => {
  const scenarios = await db.selectFrom('tax_scenarios')
    .where('household_id', '=', req.householdId!)
    .orderBy('tax_year', 'desc')
    .orderBy('created_at', 'desc')
    .selectAll()
    .execute();
  res.json(scenarios);
}));

taxesRouter.get('/scenarios/:id', asyncHandler(async (req, res) => {
  const scenario = await db.selectFrom('tax_scenarios')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .selectAll()
    .executeTakeFirst();
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  res.json(scenario);
}));

const scenarioSchema = z.object({
  tax_year: z.number().int().min(2020).max(2035),
  name: z.string().min(1).max(200),
  inputs: z.record(z.string(), z.any()),
});

taxesRouter.post('/scenarios', asyncHandler(async (req, res) => {
  const data = scenarioSchema.parse(req.body);
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insertInto('tax_scenarios').values({
    id,
    household_id: req.householdId!,
    tax_year: data.tax_year,
    name: data.name,
    inputs: JSON.stringify(data.inputs),
    created_at: now,
    updated_at: now,
  }).execute();
  res.status(201).json({ id, tax_year: data.tax_year, name: data.name, inputs: data.inputs, created_at: now, updated_at: now });
}));

taxesRouter.put('/scenarios/:id', asyncHandler(async (req, res) => {
  const data = scenarioSchema.parse(req.body);
  const updated = await db.updateTable('tax_scenarios')
    .set({
      tax_year: data.tax_year,
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

taxesRouter.delete('/scenarios/:id', asyncHandler(async (req, res) => {
  const result = await db.deleteFrom('tax_scenarios')
    .where('id', '=', req.params.id)
    .where('household_id', '=', req.householdId!)
    .executeTakeFirst();
  if (!result.numDeletedRows) return res.status(404).json({ error: 'Scenario not found' });
  res.json({ ok: true });
}));
