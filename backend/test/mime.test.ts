import { describe, expect, it } from 'vitest';
import { composeMessage } from '../src/lib/compose.js';
import { attachmentInfo, parseMessage, snippetOf } from '../src/lib/mime.js';

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
    expect(parsed.html).toContain('<b>Alice</b>');
    expect(parsed.text).toContain('Hello');
    expect(parsed.text).not.toContain('<p>');
    expect(parsed.text).not.toContain('alert');
    expect(parsed.attachments.map(attachmentInfo)).toEqual([{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 9 }]);
    expect(parsed.attachments[0]!.content.toString('latin1')).toBe('%PDF-1.4\n');
  });

  it('round-trips HTML with a text alternative and attachments in order', async () => {
    const raw = await composeMessage({
      from: { name: '', address: 'alice@example.com' },
      to: [{ name: '', address: 'bob@example.org' }],
      cc: [],
      bcc: [],
      subject: 'Files',
      text: 'Hello Bob',
      html: '<!doctype html><html><body><p>Hello <b>Bob</b></p></body></html>',
      attachments: [
        { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('first') },
        { filename: 'café.pdf', contentType: 'application/pdf', content: Buffer.from('second') },
      ],
      messageId: '<files@example.com>',
      date: new Date('2026-11-01T00:00:00Z'),
    });
    const parsed = await parseMessage(raw);
    expect(parsed.text.trim()).toBe('Hello Bob');
    expect(parsed.html).toContain('<b>Bob</b>');
    expect(parsed.attachments.map(attachmentInfo)).toEqual([
      { filename: 'notes.txt', contentType: 'text/plain', size: 5 },
      { filename: 'café.pdf', contentType: 'application/pdf', size: 6 },
    ]);
    expect(parsed.attachments.map((attachment) => attachment.content.toString())).toEqual(['first', 'second']);
  });

  it('keeps cid references and exposes the inline parts', async () => {
    const raw = [
      'From: a@example.org',
      'To: alice@example.com',
      'Subject: Logo',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="r"',
      '',
      '--r',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p><img src="cid:logo@x"></p>',
      '--r',
      'Content-Type: image/png',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--r--',
      '',
    ].join('\r\n');
    const parsed = await parseMessage(raw);
    expect(parsed.html).toContain('cid:logo@x');
    expect(parsed.attachments[0]).toMatchObject({ contentId: 'logo@x', contentType: 'image/png' });
  });

  it('builds snippets', () => {
    expect(snippetOf('  a\n\n b  ', 10)).toBe('a b');
  });
});
