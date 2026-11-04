import type { AppConfig } from './config';

/**
 * OAuth 2.0 authorization code flow with PKCE against the Cognito hosted UI. The hosted UI takes
 * care of sign-in, the first-login password change and "forgot password" (sent to the recovery email).
 */

interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface IdTokenClaims {
  sub: string;
  name?: string;
  email?: string;
  'cognito:username'?: string;
  'cognito:groups'?: string[];
  'custom:primary_email'?: string;
  exp: number;
}

const TOKENS_KEY = 'mail.tokens';
const PKCE_KEY = 'mail.pkce';
const SCOPES = 'openid email profile phone';

function redirectUri(): string {
  return `${window.location.origin}/`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function readTokens(): Tokens | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

function storeTokens(tokens: Tokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
}

export async function signIn(config: AppConfig): Promise<void> {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

  const url = new URL('/oauth2/authorize', config.hostedUiUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  window.location.assign(url.toString());
}

export function signOut(config: AppConfig): void {
  clearTokens();
  const url = new URL('/logout', config.hostedUiUrl);
  url.search = new URLSearchParams({ client_id: config.userPoolClientId, logout_uri: redirectUri() }).toString();
  window.location.assign(url.toString());
}

/** Completes the sign-in when the hosted UI redirects back with `?code=...`. */
export async function handleRedirect(config: AppConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return;

  window.history.replaceState(null, '', '/');
  if (error) throw new Error(params.get('error_description') ?? error);

  const pkce = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string } | null;
  sessionStorage.removeItem(PKCE_KEY);
  if (!pkce || pkce.state !== params.get('state')) {
    throw new Error('The sign-in response did not match this browser session. Please sign in again.');
  }

  await requestTokens(config, {
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: redirectUri(),
    code_verifier: pkce.verifier,
  });
}

/** Returns a valid ID token, refreshing it when needed, or null when the user must sign in. */
export async function getIdToken(config: AppConfig): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.idToken;
  if (!tokens.refreshToken) {
    clearTokens();
    return null;
  }
  try {
    await requestTokens(config, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken);
    return readTokens()?.idToken ?? null;
  } catch {
    clearTokens();
    return null;
  }
}

export function decodeClaims(idToken: string): IdTokenClaims {
  const payload = idToken.split('.')[1] ?? '';
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims;
}

async function requestTokens(config: AppConfig, params: Record<string, string>, previousRefreshToken?: string): Promise<void> {
  const response = await fetch(new URL('/oauth2/token', config.hostedUiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.userPoolClientId, ...params }),
  });
  if (!response.ok) throw new Error(`Token request failed (${response.status}).`);
  const body = (await response.json()) as { id_token: string; access_token: string; refresh_token?: string; expires_in: number };
  storeTokens({
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
  });
}
