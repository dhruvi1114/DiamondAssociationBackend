import { z } from 'zod';

/** Body of `POST /members/me/team`. */
export const inviteTeamMemberSchema = z.object({
  full_name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email().max(200),
  designation: z.string().trim().max(100).optional(),
});

export type InviteTeamMemberInput = z.infer<typeof inviteTeamMemberSchema>;

/** Body of `PATCH /members/me/team/:id/status`. */
export const teamStatusSchema = z.object({
  active: z.boolean(),
});

export type TeamStatusInput = z.infer<typeof teamStatusSchema>;
