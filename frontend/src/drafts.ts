import type { Attachment, Me, Message } from './api';
import { addressOf, formatDate } from './format';

export interface ForwardedAttachment extends Attachment {
  /** Index of the attachment in the forwarded message. */
  index: number;
}

export interface Draft {
  /** Mailbox to send from: one of `Me.mailboxes`. */
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** Initial HTML of the editor. */
  html: string;
  /** Id of the message being replied to, for threading headers. */
  inReplyTo?: string;
  /** The message being forwarded and those of its attachments to send along. */
  forward?: { id: string; attachments: ForwardedAttachment[] };
}

export function emptyDraft(from: string): Draft {
  return { from, to: '', cc: '', bcc: '', subject: '', html: '' };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n/g, '\n').trimEnd()).replace(/\n/g, '<br>');
}

function prefixed(prefix: string, subject: string): string {
  return new RegExp(`^${prefix}:`, 'i').test(subject) ? subject : `${prefix}: ${subject}`;
}

/** The original is quoted as text: its HTML is never put into the editor, which lives in the app's own page. */
function quote(message: Message): string {
  return `<p><br></p><p>On ${escapeHtml(formatDate(message.date))}, ${escapeHtml(message.from)} wrote:</p><blockquote>${textToHtml(message.text)}</blockquote>`;
}

export function replyDraft(message: Message, me: Me, mailbox: string, all: boolean): Draft {
  // None of the user's own mailboxes (own or collective) should be copied on a reply.
  const own = new Set(me.mailboxes.map((address) => address.toLowerCase()));
  const sentByMe = addressOf(message.from) === mailbox.toLowerCase();
  const primary = sentByMe ? message.to : message.replyTo.length > 0 ? message.replyTo : [message.from];
  const others = all ? [...message.to, ...message.cc] : [];
  const seen = new Set(primary.map(addressOf));
  const cc = others.filter((entry) => {
    const address = addressOf(entry);
    if (own.has(address) || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
  return {
    from: mailbox,
    to: primary.join(', '),
    cc: cc.join(', '),
    bcc: '',
    subject: prefixed('Re', message.subject),
    html: quote(message),
    inReplyTo: message.id,
  };
}

export function forwardDraft(message: Message, mailbox: string): Draft {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${message.from}`,
    `Date: ${formatDate(message.date)}`,
    `Subject: ${message.subject}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(', ')}`] : []),
  ];
  return {
    from: mailbox,
    to: '',
    cc: '',
    bcc: '',
    subject: prefixed('Fwd', message.subject),
    html: `<p><br></p><p>${header.map(escapeHtml).join('<br>')}</p><div>${textToHtml(message.text)}</div>`,
    forward: { id: message.id, attachments: message.attachments.map((attachment, index) => ({ ...attachment, index })) },
  };
}
