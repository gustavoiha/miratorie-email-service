import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { isOnDomain, normalizeAddress } from './addresses.js';
import { HttpError } from './http.js';

export interface Caller {
  username: string;
  name: string;
  /** The caller's mailbox address on the service domain. */
  mailbox: string;
}

export interface AuthSettings {
  accessGroup: string;
  mailDomain: string;
}

type Claims = Record<string, string | number | boolean | string[]>;

/**
 * Resolves the signed-in user from the Cognito ID token claims that API Gateway already verified,
 * and checks they are allowed to use the service.
 */
export function getCaller(event: Pick<APIGatewayProxyEventV2WithJWTAuthorizer, 'requestContext'>, settings: AuthSettings): Caller {
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Claims;

  if (claims.token_use !== 'id') {
    throw new HttpError(401, 'id_token_required', 'Call the API with the Cognito ID token.');
  }
  if (!parseGroups(claims['cognito:groups']).includes(settings.accessGroup)) {
    throw new HttpError(403, 'not_in_access_group', 'Your account has not been granted access to the email service.');
  }

  const mailbox = normalizeAddress(String(claims['custom:primary_email'] ?? ''));
  if (!isOnDomain(mailbox, settings.mailDomain)) {
    throw new HttpError(403, 'mailbox_not_configured', `Your account has no mailbox on ${settings.mailDomain}.`);
  }

  return {
    username: String(claims['cognito:username'] ?? claims.sub ?? ''),
    name: String(claims.name ?? ''),
    mailbox,
  };
}

/** API Gateway passes list claims as a string such as "[a b]"; accept that, arrays and CSV. */
export function parseGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}
