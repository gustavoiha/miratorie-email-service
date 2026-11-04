import { htmlToText } from 'html-to-text';
import { simpleParser, type AddressObject } from 'mailparser';

const MAX_HTML_TO_CONVERT = 2 * 1024 * 1024;

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedMessage {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  date?: string;
  text: string;
  hasHtml: boolean;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  attachments: AttachmentInfo[];
}

/** Parses a raw RFC 5322 message. HTML-only messages are converted to plain text. */
export async function parseMessage(raw: Buffer | string): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  return {
    from: formatAddresses(parsed.from)[0] ?? '',
    to: formatAddresses(parsed.to),
    cc: formatAddresses(parsed.cc),
    replyTo: formatAddresses(parsed.replyTo),
    subject: parsed.subject ?? '',
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined,
    text: parsed.text?.trim() ? parsed.text : htmlFallback(html),
    hasHtml: html.length > 0,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references === undefined ? [] : Array.isArray(parsed.references) ? parsed.references : [parsed.references],
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename ?? 'unnamed',
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

export function snippetOf(text: string, length = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
}

/** mailparser only converts HTML at the root or beside a text part, so convert the rest here. */
function htmlFallback(html: string): string {
  if (!html || html.length > MAX_HTML_TO_CONVERT) return '';
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

function formatAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  return objects.flatMap((object) =>
    object.value.flatMap((entry) => {
      const members = entry.group ?? [entry];
      return members.filter((member) => member.address).map((member) => (member.name ? `${member.name} <${member.address}>` : member.address!));
    }),
  );
}
