import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getRequiredAuthEnv } from '@/lib/server/auth/config';

/**
 * Better Auth session cookie name (default prefix + session_token).
 * @see https://www.better-auth.com/docs/concepts/session-management
 */
const SESSION_COOKIE = 'better-auth.session_token';
const SECURE_SESSION_COOKIE = '__Secure-better-auth.session_token';
const SESSION_COOKIE_NAMES = [SESSION_COOKIE, SECURE_SESSION_COOKIE];
const US_COUNTRY_CODE = 'US';
const COUNTRY_HEADER_NAMES = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'x-country-code',
  'x-geo-country',
];

/**
 * Routes that never require a session cookie.
 * Static assets and Next.js internals are excluded via the matcher config below.
 */
const PUBLIC_PATH_PREFIXES = [
  '/api/auth',   // Better Auth endpoints (sign-in, sign-up, callbacks, etc.)
  '/api/rate-limit/status',
  '/api/v1',     // API key / Bearer-authenticated endpoints (e.g. /api/v1/upload)
  '/signin',
  '/signup',
  '/privacy',
];
const PUBLIC_EXACT_PATHS = new Set([
  // PayPal calls the webhook without a Reader session. The return endpoint is
  // also public at middleware level so it can redirect an expired session to
  // sign-in; capture still requires the matching authenticated account.
  '/api/support/paypal/webhook',
  '/api/support/paypal/return',
]);

function isPublicPath(pathname: string): boolean {
  // Root landing page
  if (pathname === '/') return true;

  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;

  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAnonymousAuthEnabled(): boolean {
  getRequiredAuthEnv();
  const raw = process.env.USE_ANONYMOUS_AUTH_SESSIONS;
  return raw?.trim().toLowerCase() === 'true';
}

function isRichardrDevProductionInstance(): boolean {
  return process.env.RICHARDRDEV_PRODUCTION?.trim().toLowerCase() === 'true';
}

function getCountryCodeFromHeaders(request: NextRequest): string | null {
  for (const headerName of COUNTRY_HEADER_NAMES) {
    const rawValue = request.headers.get(headerName);
    if (!rawValue) continue;

    const normalized = rawValue.trim().toUpperCase();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isVerifiedProviderCallback = pathname === '/api/support/paypal/webhook';

  // PayPal delivery servers are not end users and may not carry a US country
  // header. Let the webhook reach its cryptographic signature verification.
  if (isRichardrDevProductionInstance() && !isVerifiedProviderCallback) {
    const countryCode = getCountryCodeFromHeaders(request);
    const isUnitedStatesRequest = countryCode === US_COUNTRY_CODE;

    // Strict region gate for the official production instance.
    if (!isUnitedStatesRequest) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'OpenReader is only available in the United States.' },
          { status: 451, headers: { 'Cache-Control': 'no-store' } },
        );
      }

      return new NextResponse('OpenReader is only available in the United States.', {
        status: 451,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }
  }

  getRequiredAuthEnv();

  // Fast-path redirect for signed-in users hitting the public landing page.
  // This avoids extra server work in the landing page render path.
  if (pathname === '/' && request.nextUrl.searchParams.get('redirect') !== 'false') {
    const hasSession = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
    if (hasSession) {
      const appUrl = request.nextUrl.clone();
      appUrl.pathname = '/app';
      appUrl.search = '';
      return NextResponse.redirect(appUrl);
    }
  }

  // Public routes are always accessible.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // When anonymous auth is enabled, unauthenticated users need to reach
  // the page so AuthLoader.tsx can bootstrap an anonymous session client-side.
  if (isAnonymousAuthEnabled()) {
    return NextResponse.next();
  }

  // Check for the presence of a session cookie.
  const hasSession = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));

  if (!hasSession) {
    console.log('DEBUG MIDDLEWARE 401:', { pathname });
    // API routes get a 401 instead of a redirect.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Page routes redirect to sign-in.
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/signin';
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

/**
 * Match all routes except static assets and Next.js internals.
 */
export const config = {
  matcher: [
    '/((?!api/documents/blob/upload/fallback|_next/static|_next/image|favicon\\.ico|icon\\.png|icon\\.svg|apple-icon\\.png|manifest\\.json).*)',
  ],
};
