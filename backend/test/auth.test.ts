import { describe, expect, it } from 'vitest';
import { getCaller, parseGroups, resolveMailbox } from '../src/lib/auth.js';
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
    expect(getCaller(event(validClaims), settings)).toEqual({
      username: 'alice',
      name: 'Alice',
      mailbox: 'alice@example.com',
      mailboxes: ['alice@example.com'],
    });
  });

  it('adds collective mailboxes from mailbox: groups on the domain, own mailbox first', () => {
    const caller = getCaller(
      event({
        ...validClaims,
        'cognito:groups': '[mailbox:Contact@Example.com email-users mailbox:alice@example.com mailbox:sales@other.com]',
      }),
      settings,
    );
    expect(caller.mailbox).toBe('alice@example.com');
    expect(caller.mailboxes).toEqual(['alice@example.com', 'contact@example.com']);
  });

  it('accepts users whose only mailbox is collective', () => {
    const caller = getCaller(event({ ...validClaims, 'custom:primary_email': undefined, 'cognito:groups': '[email-users mailbox:contact@example.com]' }), settings);
    expect(caller.mailbox).toBe('contact@example.com');
    expect(caller.mailboxes).toEqual(['contact@example.com']);
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

describe('resolveMailbox', () => {
  const caller = { username: 'alice', name: 'Alice', mailbox: 'alice@example.com', mailboxes: ['alice@example.com', 'contact@example.com'] };

  it('defaults to the caller mailbox and allows the ones they belong to', () => {
    expect(resolveMailbox(caller, undefined)).toBe('alice@example.com');
    expect(resolveMailbox(caller, '')).toBe('alice@example.com');
    expect(resolveMailbox(caller, 'Contact@Example.com')).toBe('contact@example.com');
  });

  it('refuses other mailboxes', () => {
    expect(() => resolveMailbox(caller, 'bob@example.com')).toThrow(expect.objectContaining({ status: 403, code: 'mailbox_forbidden' }));
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
