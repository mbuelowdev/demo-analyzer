import { OWNER_DISCORD_ID } from '../config.ts';
import { now, type DB } from '../db/index.ts';

export interface AccessPolicy {
  envAdmins: string[];
}

/** R-WL-2: owner and env-seeded admins are always whitelisted admins and can't be removed. */
export function isFixedAdmin(policy: AccessPolicy, discordId: string): boolean {
  return discordId === OWNER_DISCORD_ID || policy.envAdmins.includes(discordId);
}

export function accessFor(db: DB, policy: AccessPolicy, discordId: string): { allowed: boolean; admin: boolean } {
  if (isFixedAdmin(policy, discordId)) return { allowed: true, admin: true };
  const row = db.prepare('SELECT is_admin FROM whitelist WHERE discord_id = ?').get(discordId) as { is_admin: number } | undefined;
  return { allowed: !!row, admin: !!row?.is_admin };
}

/** R-AUTH-4: removing someone revokes their sessions and API keys immediately. */
export function revokeAccess(db: DB, discordId: string) {
  const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId) as { id: number } | undefined;
  if (!user) return;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), user.id);
}
