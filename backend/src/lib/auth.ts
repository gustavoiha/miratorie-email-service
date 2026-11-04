import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { isOnDomain, normalizeAddress } from './addresses.js';
import { HttpError } from './http.js';

/** Cognito groups named `mailbox:<address>` give their members access to a collective address. */
export const MAILBOX_GROUP_PREFIX = 'mailbox:';

export interface Caller {
  username: string;
  name: string;
  /** Default mailbox: the caller's own address (`custom:primary_email`), else their first collective one. */
  mailbox: string;
  /** Every mailbox the caller may read and send from, the default first. */
  mailboxes: string[];
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
  const groups = parseGroups(claims['cognito:groups']);
  if (!groups.includes(settings.accessGroup)) {
    throw new HttpError(403, 'not_in_access_group', 'Your account has not been granted access to the email service.');
  }

  const primary = normalizeAddress(String(claims['custom:primary_email'] ?? ''));
  const collective = groups
    .filter((group) => group.startsWith(MAILBOX_GROUP_PREFIX))
    .map((group) => normalizeAddress(group.slice(MAILBOX_GROUP_PREFIX.length)));
  const mailboxes = [...new Set([primary, ...collective])].filter((address) => isOnDomain(address, settings.mailDomain));
  if (mailboxes.length === 0) {
    throw new HttpError(403, 'mailbox_not_configured', `Your account has no mailbox on ${settings.mailDomain}.`);
  }

  return {
    username: String(claims['cognito:username'] ?? claims.sub ?? ''),
    name: String(claims.name ?? ''),
    mailbox: mailboxes[0]!,
    mailboxes,
  };
}

/** The mailbox a request acts on: the requested one if the caller has access to it, else the default. */
export function resolveMailbox(caller: Caller, requested: string | undefined): string {
  if (!requested) return caller.mailbox;
  const mailbox = normalizeAddress(requested);
  if (!caller.mailboxes.includes(mailbox)) {
    throw new HttpError(403, 'mailbox_forbidden', `You have no access to ${mailbox}.`);
  }
  return mailbox;
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
