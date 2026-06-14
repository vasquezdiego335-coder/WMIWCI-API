// ============================================================
//  MOVING SERVICE AGREEMENT — single source of truth
//
//  This is the ONLY place to edit the agreement terms.
//  - The backend stamps AGREEMENT_VERSION onto every booking the
//    customer accepts (for legal traceability).
//  - The frontend modal (contact.html) and confirmation emails
//    should mirror AGREEMENT_TEXT.
//
//  When you change the wording, BUMP AGREEMENT_VERSION so older
//  acceptances remain distinguishable from newer ones.
// ============================================================

// Bump this whenever AGREEMENT_TEXT changes. Override via env if you prefer.
export const AGREEMENT_VERSION = process.env.AGREEMENT_VERSION?.trim() || 'v2-2026-06'

/* ────────────────────────────────────────────────────────────
   PASTE / EDIT AGREEMENT TEXT BELOW.

   Pre-filled from your moving-service-agreement.docx. Two lines
   were RECONCILED to match your live flow (flagged inline):
     • Payment: your doc said "Cash · Zelle · Cash App · Venmo,
       no chargebacks". Your live flow charges a $49 card booking
       fee via Stripe, so the payment clause now reflects that.
     • Phone: doc showed 862-306-6732 (old). Updated to
       862-640-0625 to match your brand spec.
   Review both and adjust if your legal intent differs.
──────────────────────────────────────────────────────────── */
export const AGREEMENT_TEXT = `WE MOVE IT, WE CLEAR IT. — MOVING SERVICE AGREEMENT
Diego & Sebastian · West Orange, NJ · 862-640-0625

1. SCOPE OF WORK
We provide moving services only: loading your items, transporting them to the agreed destination, and unloading them safely. This job is for MOVING ONLY. No disposal, dumping, or junk removal is included unless you pay an additional disposal fee. Only the items listed and agreed upon before the job are included in the price.

2. NO DISPOSAL WITHOUT FEE
This is not a junk-removal job. No items will be taken away or disposed of. If disposal is requested, a separate junk-removal fee will be added. We will not remove or dump anything for free.

3. CUSTOMER RESPONSIBILITIES
You confirm that: all items being moved belong to you; all items are packed, safe, and ready to move; pathways, stairs, and entrances are clear; and no additional items will be added without a new price.

4. LIABILITY RELEASE
We are not responsible for: pre-existing damage to furniture or property; damage caused by weak, unstable, or poorly packed items; scratches, scuffs, or marks from normal moving; any issues or injuries after we leave; or items you failed to pack properly. You release us from all liability related to the moving service.

5. NO REFUNDS / NO RETURN TRIPS
After the job is completed: no refunds will be issued; no additional trips are included; extra work requires a new agreement and new price.

6. PAYMENT TERMS
A $49 booking fee is authorized today via Stripe — this is a hold, not a charge. We capture the $49 only when we approve your booking; if we deny it, the hold is released and you are never charged. The remaining balance for the move is due before or immediately after completion. If you add the Truck Pickup & Return option, the +$50 add-on is due on move day and is not charged today. Accepted balance payment methods: Cash, Zelle, Cash App, or Venmo.

By checking the agreement box and submitting your booking, you acknowledge that you have read and agree to all terms above. We Move It, We Clear It. is a labor-only service and is NOT a licensed moving carrier or DOT-regulated transportation company.`

// Short label used on the Discord card and in metadata.
export const AGREEMENT_LABEL = 'Moving Service Agreement'
