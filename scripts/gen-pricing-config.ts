/**
 * gen-pricing-config.ts — generates the BROWSER mirror of the price book.
 *
 *   npm run gen:pricing-config
 *
 * WHY: the booking form is static HTML/JS (WMIWCI-SITE/public/) and cannot
 * import TypeScript. Before this script, the form kept its OWN copy of the
 * price tables, hand-synced with estimate.ts — which is exactly how the
 * "$699 on the form vs $599 in the email" bug happened.
 *
 * Now there is ONE authored source (src/lib/pricing-config.ts) and this script
 * emits WMIWCI-SITE/public/js/pricing-config.js from it. The generated file is
 * checked in (the site has no build step) and
 * src/lib/__tests__/pricing-parity.test.ts fails if it drifts from the source.
 *
 * NEVER edit the generated file by hand.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  PACKAGES, PACKAGE_INCLUDES, BOOKING_AUTHORIZATION, TRUCK_PICKUP_RETURN,
  STAIRS, LONG_CARRY, ELEVATOR, ADDITIONAL_LOCATION, HEAVY_ITEM,
  NO_OVERSIZED_FURNITURE_FEE, NO_BUILDING_AGE_FEE, NO_MATTRESS_BAG_SKU,
  ADDITIONAL_ROOMS, WEEKEND_HOLIDAY, TRAVEL, NEW_YORK, PARKING_TOLLS_DELAYS,
  WAITING_TIME, ASSEMBLY, INCLUDED_EQUIPMENT, MATERIALS, SCOPE_OVERAGE,
  DISCOUNT_POLICY, DUPLICATE_CHARGE_RULES, MANUAL_REVIEW_TRIGGERS, COPY,
} from '../src/lib/pricing-config'

/** The exact object the browser receives as `window.WMIC_PRICING`. */
export function buildPricingPayload(): Record<string, unknown> {
  return {
    PACKAGES, PACKAGE_INCLUDES, BOOKING_AUTHORIZATION, TRUCK_PICKUP_RETURN,
    STAIRS, LONG_CARRY, ELEVATOR, ADDITIONAL_LOCATION, HEAVY_ITEM,
    NO_OVERSIZED_FURNITURE_FEE, NO_BUILDING_AGE_FEE, NO_MATTRESS_BAG_SKU,
    ADDITIONAL_ROOMS, WEEKEND_HOLIDAY, TRAVEL, NEW_YORK, PARKING_TOLLS_DELAYS,
    WAITING_TIME, ASSEMBLY, INCLUDED_EQUIPMENT, MATERIALS, SCOPE_OVERAGE,
    DISCOUNT_POLICY, DUPLICATE_CHARGE_RULES,
    MANUAL_REVIEW_TRIGGERS: [...MANUAL_REVIEW_TRIGGERS],
    COPY,
  }
}

/**
 * The generated file's body. Ships the DATA plus browser copies of the pure
 * resolver + formatter functions, so the form applies identical tier
 * boundaries and identical "Starting at" rendering as the server.
 */
export function renderPricingConfigJs(payload: Record<string, unknown>): string {
  return `/* =============================================================
   MOVE IT CLEAR IT — pricing-config.js  ** GENERATED FILE **

   DO NOT EDIT. Generated from WMIWCI-API/src/lib/pricing-config.ts by
   \`npm run gen:pricing-config\`. Hand edits are overwritten and will fail
   src/lib/__tests__/pricing-parity.test.ts.

   Exposes window.WMIC_PRICING — the same price book the server quotes from,
   plus the same pure resolvers, so the browser total and the stored total
   cannot disagree.
   ============================================================= */
(function () {
  'use strict';

  var P = ${JSON.stringify(payload, null, 2)};

  /* ── Resolvers: byte-for-byte the logic in pricing-config.ts ── */
  function stairChargeForFlights(flights) {
    var n = Math.max(0, Math.floor(flights || 0));
    if (n <= 1) return P.STAIRS.tiers[0];
    if (n === 2) return P.STAIRS.tiers[1];
    if (n === 3) return P.STAIRS.tiers[2];
    return P.STAIRS.tiers[3];
  }
  function longCarryChargeForFeet(feet) {
    var f = Math.max(0, Math.floor(feet || 0));
    if (f < 100) return P.LONG_CARRY.tiers[0];
    if (f <= 250) return P.LONG_CARRY.tiers[1];
    if (f <= 400) return P.LONG_CARRY.tiers[2];
    return P.LONG_CARRY.tiers[3];
  }
  function heavyItemChargeForWeight(pounds) {
    var lb = Math.max(0, Math.floor(pounds || 0));
    if (lb < 150) return { kind: 'included', per: 'item', label: 'Normal household furniture' };
    if (lb <= 249) return P.HEAVY_ITEM.tiers[0];
    if (lb <= 399) return P.HEAVY_ITEM.tiers[1];
    return P.HEAVY_ITEM.tiers[2];
  }
  function additionalLocationChargeForMiles(miles) {
    var m = Math.max(0, miles || 0);
    if (m <= 10) return P.ADDITIONAL_LOCATION.tiers[0];
    if (m <= 25) return P.ADDITIONAL_LOCATION.tiers[1];
    return P.ADDITIONAL_LOCATION.tiers[2];
  }
  function travelChargeForMinutes(minutes) {
    if (minutes === null || minutes === undefined) return P.TRAVEL.tiers[0];
    var m = Math.max(0, minutes);
    if (m <= 20) return P.TRAVEL.tiers[0];
    if (m <= 40) return P.TRAVEL.tiers[1];
    if (m <= 60) return P.TRAVEL.tiers[2];
    if (m <= 90) return P.TRAVEL.tiers[3];
    return P.TRAVEL.tiers[4];
  }

  /* ── The ONE renderer. "Starting at" is structural, never optional. ── */
  function formatCharge(ch, lang) {
    if (!ch) return '';
    var es = lang === 'es';
    function m(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }
    switch (ch.kind) {
      case 'included':       return es ? 'Incluido' : 'Included';
      case 'fixed':          return m(ch.amount);
      case 'starting':       return (es ? 'Desde ' : 'Starting at ') + m(ch.amount);
      case 'range':          return m(ch.amount) + '\\u2013' + m(ch.amountMax);
      case 'manual_quote':   return es ? 'Cotizaci\\u00f3n personalizada' : 'Custom quote';
      case 'percent':        return (ch.percent || 0) + '%';
      case 'pending_review': return es ? 'Pendiente de revisi\\u00f3n' : 'Pending review';
      case 'actual_cost':    return es ? 'Costo real documentado' : 'Actual documented cost';
      default:               return '';
    }
  }

  /* Only 'included' and plain 'fixed' may be auto-applied to a quote. */
  function isAutoApplicable(ch) {
    return !!ch && (ch.kind === 'included' || ch.kind === 'fixed') && !ch.requiresReview;
  }

  /* Discount that can NEVER touch the truck add-on or other excluded charges. */
  function applyDiscount(totals, percent) {
    var raw = isFinite(percent) ? Math.max(0, percent) : 0;
    var cap = P.DISCOUNT_POLICY.maxPublicPercent;
    var percentApplied = Math.min(raw, cap);
    var discountAmount = Math.round(totals.discountableSubtotal * percentApplied) / 100;
    var total = Math.round((totals.discountableSubtotal - discountAmount + totals.nonDiscountableSubtotal) * 100) / 100;
    return { percentApplied: percentApplied, discountAmount: discountAmount, total: total, clamped: raw > cap };
  }

  P.stairChargeForFlights = stairChargeForFlights;
  P.longCarryChargeForFeet = longCarryChargeForFeet;
  P.heavyItemChargeForWeight = heavyItemChargeForWeight;
  P.additionalLocationChargeForMiles = additionalLocationChargeForMiles;
  P.travelChargeForMinutes = travelChargeForMinutes;
  P.formatCharge = formatCharge;
  P.isAutoApplicable = isAutoApplicable;
  P.applyDiscount = applyDiscount;

  window.WMIC_PRICING = P;
})();
`
}

/** Default output path: the sibling static-site repo. */
export const DEFAULT_OUT = resolve(__dirname, '../../WMIWCI-SITE/public/js/pricing-config.js')

function main(): void {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT
  const body = renderPricingConfigJs(buildPricingPayload())
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, body, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`pricing-config.js written to ${out} (${body.length} bytes)`)
}

if (require.main === module) main()
