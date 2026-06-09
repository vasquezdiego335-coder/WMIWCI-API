import { NextRequest, NextResponse } from 'next/server'

// Stripe redirects here when the customer clicks "back" on the Checkout page.
// We send them back to the marketing site booking page.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const marketingSiteBooking = process.env.MARKETING_SITE_URL
    ? `${process.env.MARKETING_SITE_URL}#booking`
    : 'https://moveitclearit.com#booking'

  return NextResponse.redirect(marketingSiteBooking)
}
