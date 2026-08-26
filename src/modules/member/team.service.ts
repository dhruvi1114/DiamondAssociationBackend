import * as repo from '@modules/member/team.repository';
import type { TeamMemberRow } from '@modules/member/team.repository';

/**
 * The company's team roster.
 *
 * BigInt ids become strings at this boundary: JSON has no bigint, and the
 * encryption layer stringifies the payload before any custom replacer would run.
 */
export const listTeam = async (memberId: bigint): Promise<TeamMemberRow[]> => {
  const rows = await repo.findTeamByMemberId(memberId);

  return rows.map((row) => ({
    ...row,
    id: row.id.toString(),
    user_id: row.user_id.toString(),
  }));
};
