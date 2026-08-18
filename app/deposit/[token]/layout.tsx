import './deposit.css'

/**
 * Route-level layout whose ONLY job is to own the deposit page's stylesheet.
 *
 * The styles have to be imported by a SERVER component in this segment, not
 * rendered as <style>{...}</style> inside the client view. As a text node the
 * CSS was HTML-escaped on the server and not on the client, which failed
 * hydration on every apostrophe (React #425 -> #418 -> #423) and — because
 * <style> is a raw-text element the parser never decodes — also broke the hero
 * photograph's url(), producing a 404 for "/deposit/&". See deposit.css.
 *
 * It renders no markup of its own: the page and not-found views own their
 * <header>/<main> outright, and an extra wrapper element here would change the
 * approved layout.
 */
export default function DepositLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
