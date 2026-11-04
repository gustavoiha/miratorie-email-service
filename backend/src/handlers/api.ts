import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { RecipientError, parseRecipients } from '../lib/addresses.js';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_BYTES,
  attachmentDownloadUrl,
  attachmentsTooLarge,
  createUpload,
  deleteUploads,
  isUploadId,
  readUpload,
  safeContentType,
  safeFilename,
} from '../lib/attachments.js';
import { type Caller, getCaller, resolveMailbox } from '../lib/auth.js';
import { type OutgoingAttachment, composeMessage, formatRecipient } from '../lib/compose.js';
import { env } from '../lib/env.js';
import { MAX_HTML_BYTES, htmlDocument, htmlToPlainText, sanitizeIncomingHtml, sanitizeOutgoingHtml } from '../lib/html.js';
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
import { type ParsedMessage, attachmentInfo, parseMessage, snippetOf } from '../lib/mime.js';
import { deleteRawMessage, getRawMessage, putRawMessage } from '../lib/storage.js';

const ses = new SESv2Client({});

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_HTML_INPUT_BYTES = 1024 * 1024;

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  try {
    const caller = getCaller(event, { accessGroup: env.accessGroup, mailDomain: env.mailDomain });
    // Every message route acts on one mailbox: the caller's own, or a collective one they belong to.
    const mailbox = resolveMailbox(caller, event.queryStringParameters?.mailbox);
    switch (event.routeKey) {
      case 'GET /me':
        return json(200, { mailbox: caller.mailbox, mailboxes: caller.mailboxes, name: caller.name, domain: env.mailDomain });
      case 'GET /messages':
        return await list(mailbox, event);
      case 'POST /messages':
        return await send(caller, mailbox, event);
      case 'GET /messages/{id}':
        return await read(mailbox, messageIdParam(event));
      case 'PATCH /messages/{id}':
        return await update(mailbox, messageIdParam(event), event);
      case 'DELETE /messages/{id}':
        return await remove(mailbox, messageIdParam(event));
      case 'GET /messages/{id}/attachments/{index}':
        return await downloadAttachment(mailbox, messageIdParam(event), event.pathParameters?.index);
      case 'POST /attachments':
        return await upload(caller, event);
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

async function list(mailbox: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const query = event.queryStringParameters ?? {};
  const folder = query.folder ?? 'INBOX';
  if (!isFolder(folder)) throw new HttpError(400, 'invalid_folder', `Unknown folder ${folder}.`);
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '25', 10) || 25, 1), 100);
  return json(200, await listMessages(mailbox, folder, limit, query.cursor));
}

async function read(mailbox: string, id: string): Promise<APIGatewayProxyResultV2> {
  const record = await getMessage(mailbox, id);
  if (!record) throw notFound();
  const parsed = await parseMessage(await getRawMessage(record.s3Key));
  return json(200, {
    ...toSummary(record),
    replyTo: parsed.replyTo,
    text: parsed.text,
    html: displayHtml(parsed),
  });
}

/** The sanitised HTML body with inline images embedded, or undefined when there is none or it is too large. */
function displayHtml(parsed: ParsedMessage): string | undefined {
  if (!parsed.html || Buffer.byteLength(parsed.html, 'utf8') > MAX_HTML_BYTES) return undefined;
  const inlineImages = parsed.attachments.flatMap(({ contentId, contentType, content }) => (contentId ? [{ contentId, contentType, content }] : []));
  return sanitizeIncomingHtml(parsed.html, inlineImages).trim() || undefined;
}

async function downloadAttachment(mailbox: string, id: string, indexParam: string | undefined): Promise<APIGatewayProxyResultV2> {
  const index = /^\d{1,3}$/.test(indexParam ?? '') ? Number(indexParam) : -1;
  const record = await getMessage(mailbox, id);
  const attachment = record?.attachments[index];
  if (!record || !attachment) throw new HttpError(404, 'not_found', 'Attachment not found.');

  const url = await attachmentDownloadUrl({ mailbox, messageId: id, index }, attachment, async () => {
    const parsed = await parseMessage(await getRawMessage(record.s3Key));
    const part = parsed.attachments[index];
    if (!part) throw new HttpError(404, 'not_found', 'Attachment not found.');
    return part.content;
  });
  return json(200, { url, filename: attachment.filename });
}

/** Starts an attachment upload: the browser posts the file straight to S3 with the returned form. */
async function upload(caller: Caller, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event.body, event.isBase64Encoded);
  const size = Number(body.size);
  if (Number.isFinite(size) && size > MAX_ATTACHMENTS_BYTES) throw attachmentsTooLarge();
  return json(201, await createUpload(caller.username, safeContentType(body.contentType)));
}

async function update(mailbox: string, id: string, event: Event): Promise<APIGatewayProxyResultV2> {
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
  return json(200, toSummary(await updateMessage(mailbox, id, changes)));
}

async function remove(mailbox: string, id: string): Promise<APIGatewayProxyResultV2> {
  const record = await getMessage(mailbox, id);
  if (!record) throw notFound();
  if (record.folder !== 'TRASH') {
    throw new HttpError(409, 'not_in_trash', 'Move the message to the trash before deleting it permanently.');
  }
  await deleteMessage(mailbox, id);
  await deleteRawMessage(record.s3Key);
  return noContent();
}

interface UploadRef {
  id: string;
  filename: string;
  contentType: string;
}

function parseUploadRefs(input: unknown): UploadRef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'invalid_attachment', '"attachments" must be a list.');
  return input.map((entry: unknown) => {
    const ref = (entry ?? {}) as Record<string, unknown>;
    if (!isUploadId(ref.id)) throw new HttpError(400, 'invalid_attachment', 'Every attachment needs the id of its upload.');
    return { id: ref.id, filename: safeFilename(ref.filename), contentType: safeContentType(ref.contentType) };
  });
}

/** `forward: { id, attachments: [indexes] }` re-attaches attachments of a message from the same mailbox. */
function parseForward(input: unknown): { id: string; attachments: number[] } | undefined {
  if (input === undefined || input === null) return undefined;
  const forward = input as Record<string, unknown>;
  if (typeof forward !== 'object' || !isMessageId(forward.id as string)) throw notFound();
  const indexes = forward.attachments ?? [];
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index) && index >= 0)) {
    throw new HttpError(400, 'invalid_attachment', '"forward.attachments" must be a list of attachment indexes.');
  }
  return { id: forward.id as string, attachments: [...new Set(indexes as number[])] };
}

/** The body as text and, when the client sent HTML, as a sanitised HTML document. */
function parseBody(body: Record<string, unknown>): { text: string; html?: string } {
  if (typeof body.html === 'string' && body.html.trim()) {
    if (Buffer.byteLength(body.html, 'utf8') > MAX_HTML_INPUT_BYTES) throw new HttpError(400, 'body_too_large', 'The message body is too large.');
    const fragment = sanitizeOutgoingHtml(body.html);
    return { text: htmlToPlainText(fragment), html: htmlDocument(fragment) };
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new HttpError(400, 'body_too_large', 'The message body is too large.');
  return { text };
}

async function send(caller: Caller, mailbox: string, event: Event): Promise<APIGatewayProxyResultV2> {
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
  const { text, html } = parseBody(body);

  const uploads = parseUploadRefs(body.attachments);
  const forward = parseForward(body.forward);
  if (uploads.length + (forward?.attachments.length ?? 0) > MAX_ATTACHMENTS) {
    throw new HttpError(400, 'too_many_attachments', `At most ${MAX_ATTACHMENTS} attachments per message.`);
  }

  // Threading headers when replying to (or forwarding) a message from this mailbox.
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (body.inReplyTo !== undefined) {
    if (typeof body.inReplyTo !== 'string' || !isMessageId(body.inReplyTo)) throw notFound();
    const original = await getMessage(mailbox, body.inReplyTo);
    if (!original) throw notFound();
    if (original.messageIdHeader) {
      inReplyTo = original.messageIdHeader;
      references = [...(original.references ?? []), original.messageIdHeader].slice(-20);
    }
  }

  const attachments: OutgoingAttachment[] = await Promise.all(
    uploads.map(async (ref) => ({ filename: ref.filename, contentType: ref.contentType, content: await readUpload(caller.username, ref.id) })),
  );
  if (forward && forward.attachments.length > 0) {
    const original = await getMessage(mailbox, forward.id);
    if (!original) throw notFound();
    const parsed = await parseMessage(await getRawMessage(original.s3Key));
    for (const index of forward.attachments) {
      const part = parsed.attachments[index];
      if (!part) throw new HttpError(400, 'invalid_attachment', `The forwarded message has no attachment ${index}.`);
      attachments.push({ filename: safeFilename(part.filename), contentType: safeContentType(part.contentType), content: part.content });
    }
  }
  if (attachments.reduce((total, attachment) => total + attachment.content.length, 0) > MAX_ATTACHMENTS_BYTES) throw attachmentsTooLarge();

  const now = new Date();
  const unique = randomUUID();
  const id = newMessageId(now, unique);
  const messageIdHeader = `<${unique}@${env.mailDomain}>`;
  const from = { name: caller.name, address: mailbox };
  const raw = await composeMessage({ from, to, cc, bcc, subject, text, html, attachments, messageId: messageIdHeader, date: now, inReplyTo, references });

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: mailbox,
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

  const s3Key = mailboxObjectKey(mailbox, id);
  const record: MessageRecord = {
    mailbox,
    id,
    folder: 'SENT',
    folderKey: folderKey(mailbox, 'SENT'),
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
    // Same order as in the MIME message, so download indexes line up.
    attachments: attachments.map(({ filename, contentType, content }) => attachmentInfo({ filename, contentType, size: content.length })),
  };
  await putRawMessage(s3Key, raw);
  await putMessage(record);
  // The uploads expire within a day anyway; failing to delete them now is not worth failing the request.
  await deleteUploads(
    caller.username,
    uploads.map((ref) => ref.id),
  ).catch((error) => console.warn('Could not delete uploads', (error as Error).message));

  return json(201, toSummary(record));
}
