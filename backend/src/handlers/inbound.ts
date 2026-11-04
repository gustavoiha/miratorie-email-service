import type { SESEvent, SESMessage } from 'aws-lambda';
import { isOnDomain, normalizeAddress } from '../lib/addresses.js';
import { env } from '../lib/env.js';
import { mailboxObjectKey, newMessageId } from '../lib/ids.js';
import { type Folder, type MessageRecord, folderKey, putMessage } from '../lib/messages.js';
import { attachmentInfo, parseMessage, snippetOf } from '../lib/mime.js';
import { copyRawMessage, getRawMessage } from '../lib/storage.js';

/**
 * Invoked by the SES receipt rule after the S3 action stored the raw message under
 * `inbound/<SES message id>`. Copies the message into each recipient mailbox and indexes it.
 * Safe to retry: ids are derived from the SES message id, so a retry overwrites the same items.
 */
export async function handler(event: SESEvent): Promise<void> {
  for (const record of event.Records) {
    await processMessage(record.ses);
  }
}

export async function processMessage({ mail, receipt }: SESMessage): Promise<void> {
  const verdicts = {
    spam: receipt.spamVerdict?.status,
    virus: receipt.virusVerdict?.status,
    spf: receipt.spfVerdict?.status,
    dkim: receipt.dkimVerdict?.status,
    dmarc: receipt.dmarcVerdict?.status,
  };

  if (verdicts.virus === 'FAIL') {
    console.warn('Dropping message flagged as containing a virus', { messageId: mail.messageId, source: mail.source });
    return;
  }

  const recipients = [...new Set(receipt.recipients.map(normalizeAddress))].filter((address) => isOnDomain(address, env.mailDomain));
  if (recipients.length === 0) {
    console.warn('No recipients on the mail domain', { messageId: mail.messageId, recipients: receipt.recipients });
    return;
  }

  const sourceKey = `${env.inboundPrefix}${mail.messageId}`;
  const raw = await getRawMessage(sourceKey);
  const parsed = await parseMessage(raw);
  const receivedAt = new Date(mail.timestamp);
  const folder: Folder = verdicts.spam === 'FAIL' || verdicts.dmarc === 'FAIL' ? 'JUNK' : 'INBOX';

  for (const mailbox of recipients) {
    const id = newMessageId(receivedAt, mail.messageId);
    const s3Key = mailboxObjectKey(mailbox, id);
    await copyRawMessage(sourceKey, s3Key);

    const item: MessageRecord = {
      mailbox,
      id,
      folder,
      folderKey: folderKey(mailbox, folder),
      from: parsed.from || mail.source,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      snippet: snippetOf(parsed.text),
      date: parsed.date ?? receivedAt.toISOString(),
      read: false,
      s3Key,
      size: raw.length,
      messageIdHeader: parsed.messageId,
      references: parsed.references,
      attachments: parsed.attachments.map(attachmentInfo),
      verdicts,
    };
    await putMessage(item);
  }

  console.info('Delivered message', { messageId: mail.messageId, recipients: recipients.length, folder });
}
