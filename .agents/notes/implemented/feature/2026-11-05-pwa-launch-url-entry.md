# Agent Note: Offer the launch URL when a browser has no valid session

Status: implemented

English | [中文](2026-11-05-pwa-launch-url-entry.zh.md)

## Problem

`dsh web` mints a per-process launch token and prints an application URL carrying it. A browser that keeps a valid session cookie never needs that URL again, but the URL is the only route in when the cookie is absent, expired, or bound to another authority.

The cookie, its authority binding, and the token exchange are owned by [browser launch-token authentication](../architecture/2026-08-24-browser-token-authentication.md).

An installed web application has no address bar, and its start URL is fixed at install time. When such an app lands unauthenticated, the operator has no surface for pasting the printed URL, and the plain-text 401 the Host answered with offered nothing to type into.

The same launch has a browser-level quirk that makes a form-only page insufficient: a standalone launch can arrive without the `SameSite=Strict` browser cookie even though the profile holds a valid one, while a navigation started by the 401 document itself carries it. Asking for a token that is already stored reads as a broken login.

## Decision

`BrowserAuth.writeUnauthorized` answers with a self-contained HTML page instead of plain text: no framework, no external asset, one inline script and one inline stylesheet, `default-src 'none'` CSP with inline style and script only, `base-uri 'none'`, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and `cache-control: no-store`. `HEAD` keeps the same headers and no body.

The page offers a URL field prefilled with `window.location.href`. Submission accepts only `http:` and `https:` and assigns `window.location.href`, so the token is exchanged for a cookie at the URL's own authority; a URL with another authority authenticates that authority, not the app's.

Before the form is usable the page reloads itself once, guarded by a timestamp in `sessionStorage` and a five-second window. The retried navigation is started by the document, so a standalone launch that omitted the cookie is answered with an authenticated load. A second 401 inside the window shows the form, which keeps a genuinely unauthenticated visit to one extra request and no loop. Unavailable storage leaves the form as the only route.

## Alternatives considered

**Relax the cookie to `SameSite=Lax`.** Lax cookies travel on top-level `GET` navigations, so the launch would authenticate without any client-side step. It lost because it changes a deliberate security rule for every deployment, including ones that never install the app, to compensate for one browser's launch handling. The retry keeps the cookie Strict and confines the workaround to the unauthenticated page.

**Always show the form.** It is the previous behavior with better presentation, and it still asks the operator for a token that is already present but unattached. The failure it produces — a login prompt on a working session — is the one worth removing.

**Remember the last successful URL in the browser.** The token belongs to one `dsh web` process, so a remembered URL is stale after the next restart. A stale token also reaches `authorizeIndex` as a token-bearing request, which is the path this page exists to avoid.

**Send the operator to a fixed login route.** A route that accepts a pasted token still has to render a field, and the unauthenticated index response is the only document the Host serves before authentication. A separate route would duplicate that page and its headers.

## Consequences

An operator without an address bar can recover a session, and a PWA launch whose cookie was withheld now loads without interaction. Every unauthenticated visit costs one extra request; `no-store` keeps that request out of every cache.

The page is deliberately outside the client plugin tree, so its copy is fixed English rather than a locale dictionary entry, and it never follows a theme change. Any future interpolation into it would need a CSP nonce or hash instead of the current inline allowance.

The five-second window accepts a heuristic: an operator who submits a wrong URL, lands on the page again more than five seconds later, and still has no cookie sees one extra retry before the form. That cost is a single request and is preferred over a loop.
