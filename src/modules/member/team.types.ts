import { z } from 'zod';

/** Body of `PATCH /members/me/team/:id/status`. */
export const teamStatusSchema = z.object({
  active: z.boolean(),
});

export type TeamStatusInput = z.infer<typeof teamStatusSchema>;
