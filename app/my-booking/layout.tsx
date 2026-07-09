import type { ReactNode } from 'react'

// /my-booking is an interactive customer route (email lookup + booking portal).
// The page itself is a Client Component, which cannot export route segment
// config — so this thin Server Component layout carries it for the segment.
//
// force-dynamic: render per request, never statically prerender. Correct for a
// personalized, DB-backed route, and defense-in-depth against the build-time
// prerender pass. Applies to /my-booking and /my-booking/[token].
export const dynamic = 'force-dynamic'

export default function MyBookingLayout({ children }: { children: ReactNode }) {
  return children
}
