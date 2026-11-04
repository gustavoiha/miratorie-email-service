import { describe, expect, it } from 'vitest';
import { RecipientError, isOnDomain, isValidAddress, parseRecipients } from '../src/lib/addresses.js';

describe('addresses', () => {
  it('validates addresses', () => {
    expect(isValidAddress('alice@example.com')).toBe(true);
    expect(isValidAddress('alice.smith+tag@mail.example.co.uk')).toBe(true);
    expect(isValidAddress('alice@localhost')).toBe(false);
    expect(isValidAddress('not an address')).toBe(false);
    expect(isValidAddress('a@b@example.com')).toBe(false);
  });

  it('checks the domain exactly', () => {
    expect(isOnDomain('Alice@Example.com', 'example.com')).toBe(true);
    expect(isOnDomain('alice@sub.example.com', 'example.com')).toBe(false);
    expect(isOnDomain('alice@evilexample.com', 'example.com')).toBe(false);
  });

  it('parses arrays, comma separated lists and display names', () => {
    expect(parseRecipients(['Bob <BOB@example.org>, carol@example.net'], 'to')).toEqual([
      { name: 'Bob', address: 'bob@example.org' },
      { name: '', address: 'carol@example.net' },
    ]);
    expect(parseRecipients('dave@example.org', 'cc')).toEqual([{ name: '', address: 'dave@example.org' }]);
    expect(parseRecipients(undefined, 'bcc')).toEqual([]);
  });

  it('rejects invalid recipients', () => {
    expect(() => parseRecipients(['nope'], 'to')).toThrow(RecipientError);
    expect(() => parseRecipients([42], 'to')).toThrow(RecipientError);
  });
});
