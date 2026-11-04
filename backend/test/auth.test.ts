import { describe, expect, it } from 'vitest';
import { getCaller, parseGroups } from '../src/lib/auth.js';
import { HttpError } from '../src/lib/http.js';

const settings = { accessGroup: 'email-users', mailDomain: 'example.com' };

function event(claims: Record<string, unknown>) {
  return { requestContext: { authorizer: { jwt: { claims, scopes: [] } } } } as never;
}

const validClaims = {
  token_use: 'id',
  'cognito:username': 'alice',
  'cognito:groups': '[email-users]',
  name: 'Alice',
  email: 'alice.recovery@gmail.com',
  'custom:primary_email': 'Alice@Example.com',
};

describe('getCaller', () => {
  it('returns the mailbox from the primary email claim', () => {
    expect(getCaller(event(validClaims), settings)).toEqual({ username: 'alice', name: 'Alice', mailbox: 'alice@example.com' });
  });

  it('rejects users outside the access group', () => {
    expect(() => getCaller(event({ ...validClaims, 'cognito:groups': '[other]' }), settings)).toThrow(
      expect.objectContaining({ status: 403, code: 'not_in_access_group' }),
    );
  });

  it('rejects users without a mailbox on the domain', () => {
    for (const primary of [undefined, 'alice@gmail.com', 'alice@sub.example.com']) {
      expect(() => getCaller(event({ ...validClaims, 'custom:primary_email': primary }), settings)).toThrow(
        expect.objectContaining({ code: 'mailbox_not_configured' }),
      );
    }
  });

  it('requires an ID token', () => {
    expect(() => getCaller(event({ ...validClaims, token_use: 'access' }), settings)).toThrow(HttpError);
  });
});

describe('parseGroups', () => {
  it('handles the formats API Gateway may produce', () => {
    expect(parseGroups('[email-users admins]')).toEqual(['email-users', 'admins']);
    expect(parseGroups('email-users,admins')).toEqual(['email-users', 'admins']);
    expect(parseGroups(['email-users'])).toEqual(['email-users']);
    expect(parseGroups(undefined)).toEqual([]);
  });
});
