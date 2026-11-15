'use strict';
const { z } = require('zod');
const medication = require('./medication-assistant.service');
const tools = require('./app-tools.service');
const domainTools = require('./domain-tools.service');
const scales = ['small', 'normal', 'large', 'xlarge'];
const evidence = z.string().trim().min(1).max(3000);
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('language'), value: z.enum(['vi', 'en']), evidence }).strict(),
  z.object({ type: z.literal('font_size'), value: z.enum([...scales, 'increase', 'decrease']), evidence }).strict(),
  z.object({ type: z.literal('glucose'), value: z.number(), unit: z.literal('mg/dL'),
    context: z.enum(['fasting', 'pre_meal', 'post_meal', 'before_sleep', 'random']).optional(), evidence }).strict(),
  z.object({ type: z.literal('blood_pressure'), systolic: z.number(), diastolic: z.number(),
    pulse: z.number().optional(), evidence }).strict(),
  z.object({ type: z.literal('water'), volume_ml: z.number(), evidence }).strict(),
  z.object({ type: z.literal('meal'), meal_text: z.string().trim().min(1).max(1000), calories_kcal: z.number().min(0).max(10000).optional(), carbs_g: z.number().min(0).max(2000).optional(), protein_g: z.number().min(0).max(2000).optional(), fat_g: z.number().min(0).max(2000).optional(), evidence }).strict(),
  domainTools.schema,
  medication.createSchema,
  medication.moveSchema,
  medication.stateSchema,
  medication.answerSchema,
  tools.querySchema,
  tools.navigateSchema,
  tools.profileSchema,
  tools.reminderSchema,
]);

module.exports = { actionSchema, scales };
