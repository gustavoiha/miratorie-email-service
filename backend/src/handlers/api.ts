import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { RecipientError, parseRecipients } from '../lib/addresses.js';
import { type Caller, getCaller } from '../lib/auth.js';
import { composeMessage, formatRecipient } from '../lib/compose.js';
import { env } from '../lib/env.js';
import { HttpError, json, noContent, parseJsonBody } from '../lib/http.js';
import { isMessageId, mailboxObjectKey, newMessageId } from '../lib/ids.js';
import {
  type MessageRecord,
  deleteMessage,
  folderKey,
  getMessage,
  isFolder,
  listMessages,
  notFound,
  putMessage,
  toSummary,
  updateMessage,
} from '../lib/messages.js';
import { parseMessage, snippetOf } from '../lib/mime.js';
import { deleteRawMessage, getRawMessage, putRawMessage } from '../lib/storage.js';

const ses = new SESv2Client({});

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_BYTES = 512 * 1024;

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  try {
    const caller = getCaller(event, { accessGroup: env.accessGroup, mailDomain: env.mailDomain });
    switch (event.routeKey) {
      case 'GET /me':
        return json(200, { mailbox: caller.mailbox, name: caller.name, domain: env.mailDomain });
      case 'GET /messages':
        return await list(caller, event);
      case 'POST /messages':
        return await send(caller, event);
      case 'GET /messages/{id}':
        return await read(caller, messageIdParam(event));
      case 'PATCH /messages/{id}':
        return await update(caller, messageIdParam(event), event);
      case 'DELETE /messages/{id}':
        return await remove(caller, messageIdParam(event));
      default:
        return json(404, { error: 'not_found', message: `No route for ${event.routeKey}` });
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.code, message: error.message });
    }
    console.error('Unhandled error', error);
    return json(500, { error: 'internal_error', message: 'Something went wrong.' });
  }
}

function messageIdParam(event: Event): string {
  const id = event.pathParameters?.id;
  if (!isMessageId(id)) throw notFound();
  return id;
}

async function list(caller: Caller, event: Event): Promise<APIGatewayProxyResultV2> {
  const query = event.queryStringParameters ?? {};
  const folder = query.folder ?? 'INBOX';
  if (!isFolder(folder)) throw new HttpError(400, 'invalid_folder', `Unknown folder ${folder}.`);
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '25', 10) || 25, 1), 100);
  return json(200, await listMessages(caller.mailbox, folder, limit, query.cursor));
}

async function read(caller: Caller, id: string): Promise<APIGatewayProxyResultV2> {
  const record = await getMessage(caller.mailbox, id);
  if (!record) throw notFound();
  const parsed = await parseMessage(await getRawMessage(record.s3Key));
  return json(200, {
    ...toSummary(record),
    replyTo: parsed.replyTo,
    text: parsed.text,
    hasHtml: parsed.hasHtml,
  });
}

async function update(caller: Caller, id: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event.body, event.isBase64Encoded);
  const changes: { read?: boolean; folder?: MessageRecord['folder'] } = {};
  if (body.read !== undefined) {
    if (typeof body.read !== 'boolean') throw new HttpError(400, 'invalid_read', '"read" must be a boolean.');
    changes.read = body.read;
  }
  if (body.folder !== undefined) {
    if (!isFolder(body.folder)) throw new HttpError(400, 'invalid_folder', `Unknown folder ${String(body.folder)}.`);
    changes.folder = body.folder;
  }
  return json(200, toSummary(await updateMessage(caller.mailbox, id, changes)));
}

async function remove(caller: Caller, id: string): Promise<APIGatewayProxyResultV2> {
  const record = await getMessage(caller.mailbox, id);
  if (!record) throw notFound();
  if (record.folder !== 'TRASH') {
    throw new HttpError(409, 'not_in_trash', 'Move the message to the trash before deleting it permanently.');
  }
  await deleteMessage(caller.mailbox, id);
  await deleteRawMessage(record.s3Key);
  return noContent();
}

async function send(caller: Caller, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event.body, event.isBase64Encoded);

  let to, cc, bcc;
  try {
    to = parseRecipients(body.to, 'to');
    cc = parseRecipients(body.cc, 'cc');
    bcc = parseRecipients(body.bcc, 'bcc');
  } catch (error) {
    if (error instanceof RecipientError) throw new HttpError(400, 'invalid_recipient', error.message);
    throw error;
  }
  if (to.length === 0) throw new HttpError(400, 'missing_recipient', 'Add at least one recipient in "to".');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new HttpError(400, 'too_many_recipients', `At most ${MAX_RECIPIENTS} recipients per message.`);
  }

  const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  if (subject.length > MAX_SUBJECT_LENGTH) throw new HttpError(400, 'subject_too_long', 'The subject is too long.');
  const text = typeof body.text === 'string' ? body.text : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new HttpError(400, 'body_too_large', 'The message body is too large.');

  // Threading headers when replying to (or forwarding) a message from this mailbox.
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (body.inReplyTo !== undefined) {
    if (typeof body.inReplyTo !== 'string' || !isMessageId(body.inReplyTo)) throw notFound();
    const original = await getMessage(caller.mailbox, body.inReplyTo);
    if (!original) throw notFound();
    if (original.messageIdHeader) {
      inReplyTo = original.messageIdHeader;
      references = [...(original.references ?? []), original.messageIdHeader].slice(-20);
    }
  }

  const now = new Date();
  const unique = randomUUID();
  const id = newMessageId(now, unique);
  const messageIdHeader = `<${unique}@${env.mailDomain}>`;
  const from = { name: caller.name, address: caller.mailbox };
  const raw = await composeMessage({ from, to, cc, bcc, subject, text, messageId: messageIdHeader, date: now, inReplyTo, references });

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: caller.mailbox,
        Destination: {
          ToAddresses: to.map((r) => r.address),
          CcAddresses: cc.map((r) => r.address),
          BccAddresses: bcc.map((r) => r.address),
        },
        Content: { Raw: { Data: raw } },
      }),
    );
  } catch (error) {
    const name = (error as Error).name;
    console.warn('SES rejected message', name, (error as Error).message);
    if (name === 'MessageRejected' || name === 'MailFromDomainNotVerifiedException' || name === 'BadRequestException') {
      throw new HttpError(422, 'send_rejected', (error as Error).message);
    }
    if (name === 'TooManyRequestsException' || name === 'LimitExceededException' || name === 'SendingPausedException') {
      throw new HttpError(429, 'send_throttled', 'Sending is temporarily limited. Try again later.');
    }
    throw error;
  }

  const s3Key = mailboxObjectKey(caller.mailbox, id);
  const record: MessageRecord = {
    mailbox: caller.mailbox,
    id,
    folder: 'SENT',
    folderKey: folderKey(caller.mailbox, 'SENT'),
    from: formatRecipient(from),
    to: to.map(formatRecipient),
    cc: cc.map(formatRecipient),
    bcc: bcc.map(formatRecipient),
    subject,
    snippet: snippetOf(text),
    date: now.toISOString(),
    read: true,
    s3Key,
    size: raw.length,
    messageIdHeader,
    references: inReplyTo ? references : undefined,
    attachments: [],
  };
  await putRawMessage(s3Key, raw);
  await putMessage(record);

  return json(201, toSummary(record));
}
