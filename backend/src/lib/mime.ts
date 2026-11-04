import { simpleParser, type AddressObject } from 'mailparser';
import { htmlToPlainText } from './html.js';

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedAttachment extends AttachmentInfo {
  content: Buffer;
  /** Content-ID without the angle brackets, used by `cid:` references in the HTML body. */
  contentId?: string;
}

export interface ParsedMessage {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  date?: string;
  text: string;
  /** The raw, unsanitised HTML body ('' when there is none). Never return it to the browser as is. */
  html: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** In MIME order: the index is how the API addresses an attachment. */
  attachments: ParsedAttachment[];
}

/** Parses a raw RFC 5322 message. HTML-only messages get a plain-text rendering in `text`. */
export async function parseMessage(raw: Buffer | string): Promise<ParsedMessage> {
  // skipImageLinks keeps `cid:` references as they are; they are resolved when sanitising.
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  return {
    from: formatAddresses(parsed.from)[0] ?? '',
    to: formatAddresses(parsed.to),
    cc: formatAddresses(parsed.cc),
    replyTo: formatAddresses(parsed.replyTo),
    subject: parsed.subject ?? '',
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined,
    // mailparser only converts HTML at the root or beside a text part, so convert the rest here.
    text: parsed.text?.trim() ? parsed.text : htmlToPlainText(html),
    html,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references === undefined ? [] : Array.isArray(parsed.references) ? parsed.references : [parsed.references],
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename ?? 'unnamed',
      contentType: attachment.contentType,
      size: attachment.size,
      content: attachment.content,
      contentId: attachment.cid ?? attachment.contentId?.replace(/^<|>$/g, ''),
    })),
  };
}

/** The attachment metadata kept in the message index. */
export function attachmentInfo({ filename, contentType, size }: AttachmentInfo): AttachmentInfo {
  return { filename, contentType, size };
}

export function snippetOf(text: string, length = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
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
