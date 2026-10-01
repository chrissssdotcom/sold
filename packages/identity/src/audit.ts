import { schema, type PrimaryDb } from '@sold/db';
import type { Tx } from '@sold/commerce';

export interface AuditEntry {
  actorId: string | null;
  /** Human-readable actor, kept even if the user is later deleted (`system`, `scim:okta`, an email). */
  actorLabel: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Record an administrative action. Call it inside the transaction of the change it describes (pass the `tx`), so the
 * record exists if and only if the change committed. The table is append-only at the database level.
 */
export async function recordAudit(db: PrimaryDb | Tx, e: AuditEntry): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorId: e.actorId,
    actorLabel: e.actorLabel,
    action: e.action,
    targetType: e.targetType ?? '',
    targetId: e.targetId ?? '',
    detail: e.detail ?? {},
    ip: e.ip ?? null,
  });
}
