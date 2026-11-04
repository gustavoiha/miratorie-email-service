import { describe, expect, it } from 'vitest';
import { isMessageId, mailboxObjectKey, newMessageId } from '../src/lib/ids.js';
import { decodeCursor, encodeCursor, folderKey, isFolder } from '../src/lib/messages.js';

describe('message ids', () => {
  it('sort chronologically and validate', () => {
    const older = newMessageId(new Date('2026-01-01T00:00:00Z'), 'abc');
    const newer = newMessageId(new Date('2026-06-01T00:00:00Z'), 'abc');
    expect(older < newer).toBe(true);
    expect(isMessageId(older)).toBe(true);
    expect(isMessageId('../../etc/passwd')).toBe(false);
    expect(mailboxObjectKey('alice@example.com', older)).toBe(`mailboxes/alice@example.com/${older}.eml`);
  });
});

describe('folders and cursors', () => {
  it('knows the folders', () => {
    expect(isFolder('INBOX')).toBe(true);
    expect(isFolder('inbox')).toBe(false);
  });

  it('round-trips a cursor for the same folder', () => {
    const key = { mailbox: 'alice@example.com', id: '0000000000001-x', folderKey: folderKey('alice@example.com', 'INBOX') };
    expect(decodeCursor(encodeCursor(key), key.folderKey)).toEqual(key);
  });

  it('refuses a cursor for another mailbox or folder', () => {
    const key = { mailbox: 'bob@example.com', id: '0000000000001-x', folderKey: 'bob@example.com#INBOX' };
    expect(() => decodeCursor(encodeCursor(key), 'alice@example.com#INBOX')).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
    expect(() => decodeCursor('garbage', 'alice@example.com#INBOX')).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
  });
});
