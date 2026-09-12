import { describe, expect, it } from 'vitest';
import { bucketListSchema, switchPlanSchema } from '@modules/renewal/renewal.types';

describe('renewal schemas', () => {
  it('defaults to the due bucket, page 1', () => {
    expect(bucketListSchema.parse({})).toMatchObject({ bucket: 'due', page: 1, limit: 20 });
  });
  it('clamps limit to 100', () => {
    expect(bucketListSchema.parse({ limit: '500' }).limit).toBe(100);
  });
  it('rejects an unknown bucket', () => {
    expect(() => bucketListSchema.parse({ bucket: 'overdue' })).toThrow();
  });
  it('requires a numeric plan id', () => {
    expect(() => switchPlanSchema.parse({ fee_plan_id: 'abc' })).toThrow();
  });
});
