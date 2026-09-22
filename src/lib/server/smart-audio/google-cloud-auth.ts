/**
 * google-cloud-auth.ts
 *
 * Mints short-lived Google Cloud OAuth2 bearer tokens from a Service Account
 * JSON key. Uses Node.js built-in `crypto` — no `google-auth-library` or
 * other external JWT package required.
 *
 * Auth flow:
 *   1. Parse the Service Account JSON to extract `client_email` and `private_key`.
 *   2. Build a JWT assertion signed with RS256 using the private key.
 *   3. POST the JWT assertion to https://oauth2.googleapis.com/token.
 *   4. Return the access token and its expiry time.
 *
 * The token is valid for 3600 seconds (1 hour) as per Google's standard.
 * Callers are responsible for caching and refreshing before expiry.
 *
 * Required IAM permission on the GCP principal:
 *   - roles/aiplatform.user  (grants aiplatform.endpoints.predict)
 *   - roles/cloudtextospeech.user (grants texttospeech.synthesize)
 */

import { createSign } from 'crypto';

export const GOOGLE_CLOUD_TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKEN_LIFETIME_SECONDS = 3600;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoogleServiceAccountJson {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

export interface GoogleCloudBearerToken {
  accessToken: string;
  /** Unix timestamp in milliseconds when this token expires. */
  expiresAtMs: number;
}

export class GoogleCloudAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GoogleCloudAuthError';
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw Service Account JSON string.
 * Throws `GoogleCloudAuthError` if the JSON is malformed or missing required fields.
 */
export function parseServiceAccountJson(raw: string): GoogleServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GoogleCloudAuthError('Service Account JSON is not valid JSON.', err);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GoogleCloudAuthError('Service Account JSON must be a JSON object.');
  }
  const sa = parsed as Record<string, unknown>;
  if (sa.type !== 'service_account') {
    throw new GoogleCloudAuthError(
      `Service Account JSON has unexpected type "${sa.type}". Expected "service_account".`,
    );
  }
  if (typeof sa.client_email !== 'string' || !sa.client_email) {
    throw new GoogleCloudAuthError('Service Account JSON is missing "client_email".');
  }
  if (typeof sa.private_key !== 'string' || !sa.private_key) {
    throw new GoogleCloudAuthError('Service Account JSON is missing "private_key".');
  }
  return {
    type: 'service_account',
    project_id: typeof sa.project_id === 'string' ? sa.project_id : '',
    private_key_id: typeof sa.private_key_id === 'string' ? sa.private_key_id : '',
    private_key: sa.private_key,
    client_email: sa.client_email,
    token_uri: typeof sa.token_uri === 'string' ? sa.token_uri : undefined,
  };
}

// ── JWT Builder ───────────────────────────────────────────────────────────────

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Build and sign a JWT assertion for the Service Account OAuth2 flow.
 * Uses RS256 (RSASSA-PKCS1-V1_5 + SHA-256) as required by Google.
 */
function buildJwtAssertion(
  sa: GoogleServiceAccountJson,
  scope: string,
  nowSeconds: number,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri || GOOGLE_TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  }));

  const signingInput = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = base64UrlEncode(sign.sign(sa.private_key));
  return `${signingInput}.${signature}`;
}

// ── Token Exchange ────────────────────────────────────────────────────────────

/**
 * Mint a short-lived Google Cloud OAuth2 bearer token using a Service Account JSON key.
 *
 * @param serviceAccountJson  Raw Service Account JSON string (stored server-side only).
 * @param scope               OAuth2 scope (defaults to cloud-platform).
 * @returns `{ accessToken, expiresAtMs }` — the access token and its expiry time.
 */
export async function mintGoogleCloudBearerToken(
  serviceAccountJson: string,
  scope: string = GOOGLE_CLOUD_TTS_SCOPE,
): Promise<GoogleCloudBearerToken> {
  const sa = parseServiceAccountJson(serviceAccountJson);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = buildJwtAssertion(sa, scope, nowSeconds);

  const tokenEndpoint = sa.token_uri || GOOGLE_TOKEN_ENDPOINT;
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
  } catch (err) {
    throw new GoogleCloudAuthError('Failed to reach Google token endpoint.', err);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as Record<string, unknown>;
      detail = typeof body.error_description === 'string'
        ? body.error_description
        : JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new GoogleCloudAuthError(
      `Google token endpoint returned HTTP ${response.status}: ${detail}`,
    );
  }

  const json = await response.json() as Record<string, unknown>;
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new GoogleCloudAuthError('Google token response did not include an access_token.');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : TOKEN_LIFETIME_SECONDS;

  return {
    accessToken: json.access_token,
    expiresAtMs: (nowSeconds + expiresIn) * 1000,
  };
}

// ── Application Default Credentials (ADC) fallback ───────────────────────────

/**
 * Fetch a bearer token via the GCE metadata server (Application Default Credentials).
 * This works when OpenReader is running inside GCP (GKE, Cloud Run, Compute Engine).
 *
 * Returns null if the metadata server is not reachable (not running in GCP).
 */
export async function fetchAdcBearerToken(): Promise<GoogleCloudBearerToken | null> {
  const metadataUrl =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  try {
    const response = await fetch(metadataUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const json = await response.json() as Record<string, unknown>;
    if (typeof json.access_token !== 'string') return null;
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : TOKEN_LIFETIME_SECONDS;
    return {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

// ── Unified Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a Google Cloud bearer token for a drama-gemini-tts profile.
 *
 * Priority:
 *   1. Profile Service Account JSON (if configured)
 *   2. Application Default Credentials / GCE metadata server
 *
 * Throws `GoogleCloudAuthError` if neither source yields a token.
 */
export async function resolveGoogleCloudBearerToken(options: {
  serviceAccountJson?: string;
  scope?: string;
}): Promise<GoogleCloudBearerToken> {
  const scope = options.scope ?? GOOGLE_CLOUD_TTS_SCOPE;

  if (options.serviceAccountJson) {
    return mintGoogleCloudBearerToken(options.serviceAccountJson, scope);
  }

  const adcToken = await fetchAdcBearerToken();
  if (adcToken) return adcToken;

  throw new GoogleCloudAuthError(
    'No Google Cloud credentials found. ' +
    'Configure a Service Account JSON in the Drama (Gemini TTS) profile settings, ' +
    'or deploy OpenReader in a GCP environment with Application Default Credentials.',
  );
}
