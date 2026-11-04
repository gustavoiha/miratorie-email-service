import MailComposer from 'nodemailer/lib/mail-composer';
import type { Recipient } from './addresses.js';

export interface OutgoingMessage {
  from: Recipient;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
}

/** Builds the raw MIME message. Bcc recipients are left out of the headers. */
export async function composeMessage(message: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    messageId: message.messageId,
    date: message.date,
    inReplyTo: message.inReplyTo,
    references: message.references,
    textEncoding: 'quoted-printable',
  });
  return composer.compile().build();
}

export function formatRecipient(recipient: Recipient): string {
  return recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address;
}
