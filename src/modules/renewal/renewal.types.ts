import { z } from 'zod';

export const bucketListSchema = z.object({
  bucket: z.enum(['due', 'grace', 'expired']).default('due'),
  page: z.coerce.number().int().min(1).default(1),
  // Clamped, never rejected — the list contract every admin list follows (testing-strategy §5).
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((n) => Math.min(n, 100)),
  search: z.string().trim().max(100).optional(),
});
export type BucketListQuery = z.infer<typeof bucketListSchema>;

export const switchPlanSchema = z.object({
  fee_plan_id: z.string().regex(/^\d+$/, 'validation.invalidNumber'),
});
export type SwitchPlanBody = z.infer<typeof switchPlanSchema>;
