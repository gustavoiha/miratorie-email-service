import { htmlToText } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';

/** HTML larger than this is not converted or returned (Lambda responses are limited to 6 MB). */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Inline (`cid:`) images are embedded as data: URLs up to this many bytes per message. */
export const INLINE_IMAGE_BUDGET_BYTES = 2 * 1024 * 1024;

export interface InlineImage {
  /** Content-ID without the angle brackets. */
  contentId: string;
  contentType: string;
  content: Buffer;
}

const INCOMING_TAGS = [
  'a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
  'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u',
  'ul', 'var', 'wbr',
];

const PRESENTATION_ATTRIBUTES = [
  'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'colspan', 'dir', 'face', 'height', 'id',
  'lang', 'rowspan', 'size', 'style', 'title', 'valign', 'width',
];

/**
 * Sanitises the HTML body of a received message for display. The web client additionally renders
 * the result in a sandboxed iframe without scripts and with its own Content-Security-Policy, which
 * is what blocks remote images and CSS-loaded resources; this function removes everything active
 * (scripts, event handlers, forms, frames, embeds, `javascript:` URLs) and rewrites links to open in
 * a new tab. `cid:` images are replaced by data: URLs from `inlineImages`, within a size budget.
 */
export function sanitizeIncomingHtml(html: string, inlineImages: InlineImage[] = []): string {
  const byContentId = new Map(inlineImages.map((image) => [image.contentId.toLowerCase(), image]));
  let budget = INLINE_IMAGE_BUDGET_BYTES;

  return sanitizeHtml(html, {
    allowedTags: INCOMING_TAGS,
    allowedAttributes: {
      '*': PRESENTATION_ATTRIBUTES,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      ol: ['start', 'type'],
      td: ['abbr', 'headers', 'scope', 'nowrap'],
      th: ['abbr', 'headers', 'scope', 'nowrap'],
      table: ['summary', 'frame', 'rules'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    // <style> is needed by most HTML mail. It is safe here because the CSS only applies inside the
    // isolated iframe, whose CSP blocks external stylesheets, fonts and (by default) images.
    allowVulnerableTags: true,
    // Disallowed tags keep their text, except these. (<head> itself is dropped but its <style> kept.)
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'xml'],
    // Relative URLs mean nothing in a message (they would point at the web client itself), so they are dropped.
    transformTags: {
      a: (tagName, { href, ...attribs }) => ({
        tagName,
        attribs: { ...attribs, ...(href && /^\s*(https?:|mailto:|tel:)/i.test(href) ? { href } : {}), target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        if (/^(https?:|data:)/i.test(src)) return { tagName, attribs };
        const { src: _src, ...rest } = attribs;
        const image = /^cid:/i.test(src) ? byContentId.get(contentIdOf(src.slice(4))) : undefined;
        if (!image || !/^image\//i.test(image.contentType) || image.content.length > budget) return { tagName, attribs: rest };
        budget -= image.content.length;
        return { tagName, attribs: { ...rest, src: `data:${image.contentType.toLowerCase()};base64,${image.content.toString('base64')}` } };
      },
    },
  });
}

function contentIdOf(reference: string): string {
  let id = reference;
  try {
    id = decodeURIComponent(reference);
  } catch {
    // Not percent-encoded after all.
  }
  return id.replace(/^<|>$/g, '').toLowerCase();
}

/**
 * Sanitises HTML written in the web client's editor before it is sent: simple formatting, lists,
 * quotes and links only.
 */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strike', 'strong', 'u', 'ul'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
  }).trim();
}

/** Wraps an HTML fragment into the document that goes into the MIME message. */
export function htmlDocument(fragment: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    '<body style="font-family: system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif; font-size: 15px; line-height: 1.45;">',
    fragment,
    '</body></html>',
  ].join('\n');
}

/** Plain-text rendering of an HTML body: the text part of outgoing mail and the fallback of HTML-only mail. */
export function htmlToPlainText(html: string): string {
  if (!html || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return '';
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim();
}
