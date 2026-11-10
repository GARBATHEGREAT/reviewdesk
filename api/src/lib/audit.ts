import type { Db } from '../db/pool.js';

export async function audit(
  db: Db,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db.query('INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES ($1, $2, $3, $4, $5)', [
    actorId,
    action,
    entity,
    entityId,
    JSON.stringify(meta),
  ]);
}
