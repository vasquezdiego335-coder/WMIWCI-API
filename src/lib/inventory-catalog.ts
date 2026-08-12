// ============================================================================
// Default inventory catalog (Moving OS Phase 1, owner spec 2026-08-11).
//
// ~40 common moving items that seed the InventoryCatalogItem table so the
// Book Move inventory picker is useful on day one. Seeding is LAZY: the
// catalog GET route calls ensureCatalogSeeded() on first use, so a database
// with migration 20260811000000_moving_os_phase1 applied gets seeded on the
// first page load, and an unapplied database fails soft at the route (the
// P2021 table-missing error propagates to the route's fail-soft handler —
// this module never swallows it).
//
// These are DEFAULTS, not truth: owners can add/deactivate rows. Booking
// lines snapshot name/isHeavy/needsDisassembly at booking time, so editing
// this list never rewrites what a past move actually carried.
// ============================================================================

export type InventoryCategory =
  | 'furniture'
  | 'boxes'
  | 'beds'
  | 'appliances'
  | 'tvs'
  | 'specialty'
  | 'heavy'
  | 'other'

export type DefaultCatalogItem = {
  name: string
  category: InventoryCategory
  isHeavy?: boolean
  needsDisassembly?: boolean
  recommendedMovers?: number
}

export const DEFAULT_INVENTORY_CATALOG: DefaultCatalogItem[] = [
  // ── Beds ──────────────────────────────────────────────────────────────────
  { name: 'King bed frame', category: 'beds', needsDisassembly: true },
  { name: 'Queen bed frame', category: 'beds', needsDisassembly: true },
  { name: 'Full bed frame', category: 'beds', needsDisassembly: true },
  { name: 'Twin bed frame', category: 'beds', needsDisassembly: true },
  { name: 'King mattress', category: 'beds' },
  { name: 'Queen mattress', category: 'beds' },
  { name: 'Full mattress', category: 'beds' },
  { name: 'Twin mattress', category: 'beds' },
  { name: 'Box spring', category: 'beds' },
  // ── Furniture ─────────────────────────────────────────────────────────────
  { name: 'Dresser', category: 'furniture' },
  { name: 'Nightstand', category: 'furniture' },
  { name: 'Couch (3-seat)', category: 'furniture', recommendedMovers: 2 },
  { name: 'Loveseat', category: 'furniture' },
  {
    name: 'Sectional couch',
    category: 'furniture',
    isHeavy: true,
    needsDisassembly: true,
    recommendedMovers: 3,
  },
  { name: 'Recliner', category: 'furniture' },
  { name: 'Dining table', category: 'furniture', needsDisassembly: true },
  { name: 'Dining chair', category: 'furniture' },
  { name: 'Coffee table', category: 'furniture' },
  { name: 'Desk', category: 'furniture', needsDisassembly: true },
  { name: 'Office chair', category: 'furniture' },
  { name: 'Bookshelf', category: 'furniture' },
  // ── TVs ───────────────────────────────────────────────────────────────────
  { name: 'TV (up to 43")', category: 'tvs' },
  { name: 'TV (50-65")', category: 'tvs' },
  { name: 'TV (70"+)', category: 'tvs', recommendedMovers: 2 },
  // ── Appliances ────────────────────────────────────────────────────────────
  { name: 'Washer', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Dryer', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Refrigerator', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Stove / range', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Dishwasher', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Chest freezer', category: 'appliances', isHeavy: true, recommendedMovers: 2 },
  { name: 'Microwave', category: 'appliances' },
  // ── Boxes / bags ──────────────────────────────────────────────────────────
  { name: 'Small box', category: 'boxes' },
  { name: 'Medium box', category: 'boxes' },
  { name: 'Large box', category: 'boxes' },
  { name: 'Wardrobe box', category: 'boxes' },
  { name: 'Bag of items', category: 'boxes' },
  // ── Heavy specialty ───────────────────────────────────────────────────────
  { name: 'Piano (upright)', category: 'heavy', isHeavy: true, recommendedMovers: 4 },
  { name: 'Safe', category: 'heavy', isHeavy: true, recommendedMovers: 3 },
  {
    name: 'Pool table',
    category: 'heavy',
    isHeavy: true,
    needsDisassembly: true,
    recommendedMovers: 3,
  },
  {
    name: 'Treadmill',
    category: 'heavy',
    isHeavy: true,
    needsDisassembly: true,
    recommendedMovers: 2,
  },
  { name: 'Elliptical', category: 'heavy', isHeavy: true, recommendedMovers: 2 },
  // ── Fragile specialty ─────────────────────────────────────────────────────
  { name: 'Large mirror', category: 'specialty' },
  { name: 'Framed art', category: 'specialty' },
  // ── Other ─────────────────────────────────────────────────────────────────
  { name: 'Grill', category: 'other' },
  { name: 'Patio set', category: 'other' },
  { name: 'Lamp', category: 'other' },
  { name: 'Area rug', category: 'other' },
]

/**
 * Minimal structural slice of PrismaClient this module needs. Structural (not
 * `PrismaClient`) so offline tests can hand in a fake without the generated
 * client, and so this file stays importable from pure test contexts.
 */
type CatalogSeedClient = {
  inventoryCatalogItem: {
    createMany(args: {
      data: Array<{
        name: string
        category: string
        isHeavy: boolean
        needsDisassembly: boolean
        recommendedMovers: number | null
      }>
      skipDuplicates: boolean
    }): Promise<unknown>
  }
}

// Per-process memo so the lazy seed does not cost a write on every catalog GET.
// Set only AFTER a successful insert: a failed attempt (e.g. migration not
// applied yet -> P2021) stays un-memoed and retries on the next request.
let seededThisProcess = false

/**
 * Insert any DEFAULT_INVENTORY_CATALOG items that are missing (matched by the
 * unique `name`). Idempotent via createMany + skipDuplicates: existing rows —
 * including owner-edited ones — are never touched. Errors propagate; the
 * calling route owns fail-soft handling (house pattern for unapplied
 * migrations).
 */
export async function ensureCatalogSeeded(prisma: CatalogSeedClient): Promise<void> {
  if (seededThisProcess) return
  await prisma.inventoryCatalogItem.createMany({
    data: DEFAULT_INVENTORY_CATALOG.map((item) => ({
      name: item.name,
      category: item.category,
      isHeavy: item.isHeavy ?? false,
      needsDisassembly: item.needsDisassembly ?? false,
      recommendedMovers: item.recommendedMovers ?? null,
    })),
    skipDuplicates: true,
  })
  seededThisProcess = true
}
