import { describe, expect, it } from 'vitest';
import { composeMessage } from '../src/lib/compose.js';
import { parseMessage, snippetOf } from '../src/lib/mime.js';

describe('compose and parse', () => {
  it('round-trips a plain text message without leaking Bcc', async () => {
    const raw = await composeMessage({
      from: { name: 'Alice', address: 'alice@example.com' },
      to: [{ name: 'Bob', address: 'bob@example.org' }],
      cc: [{ name: '', address: 'carol@example.net' }],
      bcc: [{ name: '', address: 'secret@example.net' }],
      subject: 'Héllo there',
      text: 'Line one\nLine two — with unicode ✓',
      messageId: '<abc@example.com>',
      date: new Date('2026-10-28T12:00:00Z'),
      inReplyTo: '<parent@example.org>',
      references: ['<root@example.org>', '<parent@example.org>'],
    });

    expect(raw.toString('utf8')).not.toContain('secret@example.net');

    const parsed = await parseMessage(raw);
    expect(parsed.from).toBe('Alice <alice@example.com>');
    expect(parsed.to).toEqual(['Bob <bob@example.org>']);
    expect(parsed.cc).toEqual(['carol@example.net']);
    expect(parsed.subject).toBe('Héllo there');
    expect(parsed.text.trim()).toBe('Line one\nLine two — with unicode ✓');
    expect(parsed.messageId).toBe('<abc@example.com>');
    expect(parsed.inReplyTo).toBe('<parent@example.org>');
    expect(parsed.references).toEqual(['<root@example.org>', '<parent@example.org>']);
    expect(parsed.date).toBe('2026-10-28T12:00:00.000Z');
  });

  it('converts HTML-only messages to text and lists attachments', async () => {
    const raw = [
      'From: Shop <news@shop.example>',
      'To: alice@example.com',
      'Subject: Deals',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hello <b>Alice</b></p><script>alert(1)</script>',
      '--b',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--b--',
      '',
    ].join('\r\n');

    const parsed = await parseMessage(raw);
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.text).toContain('Hello');
    expect(parsed.text).not.toContain('<p>');
    expect(parsed.text).not.toContain('alert');
    expect(parsed.attachments).toEqual([{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 9 }]);
  });

  it('builds snippets', () => {
    expect(snippetOf('  a\n\n b  ', 10)).toBe('a b');
  });
});
