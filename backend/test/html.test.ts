import { describe, expect, it } from 'vitest';
import { htmlDocument, htmlToPlainText, sanitizeIncomingHtml, sanitizeOutgoingHtml } from '../src/lib/html.js';

describe('incoming HTML', () => {
  it('removes everything active', () => {
    const html = sanitizeIncomingHtml(
      [
        '<script>alert(1)</script>',
        '<img src="x" onerror="alert(2)">',
        '<a href="javascript:alert(3)">js</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<form action="https://evil.example"><input name="password"></form>',
        '<object data="x"></object><embed src="x">',
        '<svg><script>alert(4)</script></svg>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<link rel="stylesheet" href="https://evil.example/a.css">',
        '<base href="https://evil.example/">',
        '<p style="color:red" onclick="alert(5)">kept</p>',
      ].join(''),
    );
    expect(html).not.toMatch(/script|onerror|onclick|javascript:|iframe|<form|<input|object|embed|<svg|<meta|<link|<base|alert/i);
    expect(html).toContain('<p style="color:red">kept</p>');
  });

  it('keeps layout and styles, and opens links in a new tab', () => {
    const html = sanitizeIncomingHtml(
      '<html><head><title>Ignored</title><style>.a > b { color: red }</style></head><body><table width="100%"><tr><td class="a" bgcolor="#fff"><a href="https://example.org/x">x</a></td></tr></table></body></html>',
    );
    expect(html).not.toContain('Ignored');
    expect(html).toContain('<style>.a > b { color: red }</style>');
    expect(html).toContain('<td class="a" bgcolor="#fff">');
    expect(html).toContain('<a href="https://example.org/x" target="_blank" rel="noopener noreferrer">x</a>');
  });

  it('keeps remote image URLs for the client to block, and embeds cid images within a budget', () => {
    const png = Buffer.from('iVBORw0KGgo=', 'base64');
    const html = sanitizeIncomingHtml('<img src="https://tracker.example/p.gif"><img src="cid:logo@x"><img src="cid:missing@x">', [
      { contentId: 'logo@x', contentType: 'image/png', content: png },
    ]);
    expect(html).toContain('<img src="https://tracker.example/p.gif" />');
    expect(html).toContain(`<img src="data:image/png;base64,${png.toString('base64')}" />`);
    expect(html).toContain('<img />');
  });

  it('drops relative and malformed URLs, which would point at the web client', () => {
    const html = sanitizeIncomingHtml('<a href="/settings">a</a><a href="#top">b</a><img src="x.png"><img src="cid:%E0%A4%A">');
    expect(html).toBe(
      '<a target="_blank" rel="noopener noreferrer">a</a><a target="_blank" rel="noopener noreferrer">b</a><img /><img />',
    );
  });

  it('does not embed inline parts that are not images', () => {
    const html = sanitizeIncomingHtml('<img src="cid:doc@x">', [{ contentId: 'doc@x', contentType: 'text/html', content: Buffer.from('<script>') }]);
    expect(html).toBe('<img />');
  });
});

describe('outgoing HTML', () => {
  it('keeps simple formatting only', () => {
    const html = sanitizeOutgoingHtml(
      '<p style="color:red">Hi <b>Bob</b> <a href="https://example.org" onclick="x()">link</a> <a href="javascript:x()">bad</a></p><ul><li>one</li></ul><blockquote>q</blockquote><img src="https://t.example/p.gif"><table><tr><td>cell</td></tr></table>',
    );
    expect(html).toBe('<p>Hi <b>Bob</b> <a href="https://example.org">link</a> <a>bad</a></p><ul><li>one</li></ul><blockquote>q</blockquote>cell');
  });

  it('renders a text alternative with quotes and links', () => {
    const text = htmlToPlainText('<p>Hi <a href="https://example.org">site</a></p><blockquote>quoted<br>line</blockquote>');
    expect(text).toContain('Hi site [https://example.org]');
    expect(text).toContain('> quoted\n> line');
  });

  it('wraps a fragment into a document', () => {
    expect(htmlDocument('<p>x</p>')).toMatch(/^<!doctype html>[\s\S]*<meta charset="utf-8">[\s\S]*<p>x<\/p>[\s\S]*<\/html>$/);
  });
});
