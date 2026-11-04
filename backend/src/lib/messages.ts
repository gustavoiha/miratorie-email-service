import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AttachmentInfo } from './mime.js';
import { env } from './env.js';
import { HttpError } from './http.js';

export const FOLDERS = ['INBOX', 'SENT', 'JUNK', 'TRASH'] as const;
export type Folder = (typeof FOLDERS)[number];

export function isFolder(value: unknown): value is Folder {
  return typeof value === 'string' && (FOLDERS as readonly string[]).includes(value);
}

export interface Verdicts {
  spam?: string;
  virus?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

/** One message in one mailbox, as stored in DynamoDB. The raw MIME lives in S3 under `s3Key`. */
export interface MessageRecord {
  mailbox: string;
  id: string;
  folder: Folder;
  /** `${mailbox}#${folder}`: partition key of the folder index. */
  folderKey: string;
  from: string;
  to: string[];
  cc: string[];
  bcc?: string[];
  subject: string;
  snippet: string;
  date: string;
  read: boolean;
  s3Key: string;
  size: number;
  messageIdHeader?: string;
  references?: string[];
  attachments: AttachmentInfo[];
  verdicts?: Verdicts;
}

/** What the API returns for a message in a list. */
export type MessageSummary = Omit<MessageRecord, 'mailbox' | 'folderKey' | 's3Key' | 'references' | 'messageIdHeader'>;

export function folderKey(mailbox: string, folder: Folder): string {
  return `${mailbox}#${folder}`;
}

export function toSummary(record: MessageRecord): MessageSummary {
  const { mailbox: _mailbox, folderKey: _folderKey, s3Key: _s3Key, references: _references, messageIdHeader: _messageId, ...summary } = record;
  return summary;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function putMessage(record: MessageRecord): Promise<void> {
  await db.send(new PutCommand({ TableName: env.tableName, Item: record }));
}

export async function getMessage(mailbox: string, id: string): Promise<MessageRecord | undefined> {
  const result = await db.send(new GetCommand({ TableName: env.tableName, Key: { mailbox, id } }));
  return result.Item as MessageRecord | undefined;
}

export interface MessagePage {
  messages: MessageSummary[];
  cursor?: string;
}

export async function listMessages(mailbox: string, folder: Folder, limit: number, cursor?: string): Promise<MessagePage> {
  const key = folderKey(mailbox, folder);
  const result = await db.send(
    new QueryCommand({
      TableName: env.tableName,
      IndexName: env.tableIndex,
      KeyConditionExpression: 'folderKey = :key',
      ExpressionAttributeValues: { ':key': key },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: cursor ? decodeCursor(cursor, key) : undefined,
    }),
  );
  return {
    messages: (result.Items ?? []).map((item) => toSummary(item as MessageRecord)),
    cursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined,
  };
}

export async function updateMessage(mailbox: string, id: string, changes: { read?: boolean; folder?: Folder }): Promise<MessageRecord> {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  if (changes.read !== undefined) {
    sets.push('#read = :read');
    names['#read'] = 'read';
    values[':read'] = changes.read;
  }
  if (changes.folder !== undefined) {
    sets.push('#folder = :folder', 'folderKey = :folderKey');
    names['#folder'] = 'folder';
    values[':folder'] = changes.folder;
    values[':folderKey'] = folderKey(mailbox, changes.folder);
  }
  if (sets.length === 0) throw new HttpError(400, 'nothing_to_update', 'Provide "read" and/or "folder".');

  try {
    const result = await db.send(
      new UpdateCommand({
        TableName: env.tableName,
        Key: { mailbox, id },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(mailbox)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes as MessageRecord;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw notFound();
    throw error;
  }
}

export async function deleteMessage(mailbox: string, id: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: env.tableName, Key: { mailbox, id } }));
}

export function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Message not found.');
}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decodes a pagination cursor, refusing cursors that point outside the caller's folder. */
export function decodeCursor(cursor: string, expectedFolderKey: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const mailbox = expectedFolderKey.slice(0, expectedFolderKey.lastIndexOf('#'));
    if (key.folderKey === expectedFolderKey && key.mailbox === mailbox && typeof key.id === 'string' && Object.keys(key).length === 3) {
      return key;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
}
