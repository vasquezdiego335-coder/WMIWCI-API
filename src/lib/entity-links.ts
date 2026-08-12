// ============================================================================
// Centralized admin entity-link builder (increment 2.1). THE single place that
// maps an entity type+id to an admin URL. Returns null when no page exists yet
// (e.g. leads have no detail page), so reminders never render a broken link.
// Pure + offline-tested (entity-links.test.ts).
// ============================================================================

export type EntityType = 'booking' | 'expense' | 'owner_transaction' | 'lead' | 'customer' | 'crew' | 'job'

// Which entity types currently have a real admin destination. Update this map
// (not the rules) when pages ship.
const ENTITY_ROUTES: Record<EntityType, ((id: string) => string) | null> = {
  booking: (id) => `/admin/jobs/${id}`,
  job: (id) => `/admin/jobs/${id}`,
  expense: () => '/admin/expenses',
  owner_transaction: () => '/admin/owner-money',
  customer: () => '/admin/customers',
  crew: () => '/admin/staff',
  // Lead detail shipped in Moving OS Phase 1 Stage 2C (/admin/leads/[id]).
  lead: (id) => `/admin/leads/${id}`,
}

/** Admin URL for an entity, or null when the destination does not exist. */
export function entityLink(type: string, id: string | null | undefined): string | null {
  const builder = ENTITY_ROUTES[type as EntityType]
  if (builder === undefined || builder === null) return null
  if (!id) return builder('')
  return builder(id)
}

/** True when this entity type has a real admin page. */
export function hasEntityPage(type: string): boolean {
  return !!ENTITY_ROUTES[type as EntityType]
}
