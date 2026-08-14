// ============================================================================
// travel-buffer.ts — THE house travel buffer, in ONE place.
//
// A job's operational window is longer than the labor itself: the crew drives
// to the origin, drives between addresses and returns the truck. Every place
// that turns "estimated hours" into a real window adds the SAME buffer:
//
//   • scheduling.calculateEndTime      — the scheduledStart → scheduledEnd the
//                                        admin create and approveBooking write
//   • truck-conflicts.truckHoldHours   — the window a booking with no stored
//                                        scheduledEnd holds its truck for
//
// WHY A SEPARATE MODULE: truck-conflicts.ts is PURE (no Prisma, offline-
// testable, and reachable from the 'use client' Book Move form via
// admin-booking.ts), so it cannot import scheduling.ts — scheduling.ts imports
// ./db. Copying `60` into the conflict lib instead would recreate exactly the
// defect class that lost round R2-2 (a second copy of a shared constant that
// then drifted). This module imports nothing, so both sides can have it.
//
// The value itself is unchanged: TRAVEL_BUFFER_MINUTES, default 60.
// ============================================================================

/** Minutes added to a job's estimated labor hours to get its real window. */
export const TRAVEL_BUFFER_MINUTES = parseInt(process.env.TRAVEL_BUFFER_MINUTES ?? '60', 10)

/** The same buffer in hours — what the truck-hold math works in. */
export const TRAVEL_BUFFER_HOURS = TRAVEL_BUFFER_MINUTES / 60
