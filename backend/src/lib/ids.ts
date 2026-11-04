import { randomUUID } from 'node:crypto';

const MESSAGE_ID_RE = /^\d{13}-[A-Za-z0-9-]{1,100}$/;

/**
 * Message ids sort chronologically: a zero padded epoch-millisecond timestamp followed by a
 * unique suffix. Inbound messages use the SES message id as suffix, so retries are idempotent.
 */
export function newMessageId(date: Date, unique: string = randomUUID()): string {
  return `${String(date.getTime()).padStart(13, '0')}-${unique}`;
}

export function isMessageId(value: string | undefined): value is string {
  return typeof value === 'string' && MESSAGE_ID_RE.test(value);
}

export function mailboxObjectKey(mailbox: string, id: string): string {
  return `mailboxes/${mailbox}/${id}.eml`;
}
