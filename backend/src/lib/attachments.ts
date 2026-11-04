import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';
import { HttpError } from './http.js';
import type { AttachmentInfo } from './mime.js';

/**
 * Attachments travel through the transfer bucket, whose objects expire after a day:
 * - uploads/<owner>/<upload id>: files the browser uploads with a presigned POST before sending;
 * - downloads/<mailbox>/<message id>/<index>: attachments extracted from a stored message, served
 *   with short-lived presigned GET URLs (and reused while they exist).
 */

/** Total size of the attachments of one outgoing message. Base64 makes it about 35 MB, under the SES limit of 40 MB. */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
const UPLOAD_URL_SECONDS = 15 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const s3 = new S3Client({});

export interface Upload {
  id: string;
  /** Form target and fields of the presigned POST; the file goes last, as the `file` field. */
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
}

export function isUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_RE.test(value);
}

/** Keeps a file name displayable and harmless: no paths, control characters or surrounding dots. */
export function safeFilename(value: unknown): string {
  const name = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200);
  return name || 'attachment';
}

export function safeContentType(value: unknown): string {
  const type = String(value ?? '').trim().toLowerCase().split(';')[0]!.trim();
  return CONTENT_TYPE_RE.test(type) ? type : 'application/octet-stream';
}

function uploadKey(owner: string, id: string): string {
  return `uploads/${encodeURIComponent(owner)}/${id}`;
}

export async function createUpload(owner: string, contentType: string): Promise<Upload> {
  const id = randomUUID();
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: env.transferBucketName,
    Key: uploadKey(owner, id),
    Conditions: [['content-length-range', 0, MAX_ATTACHMENTS_BYTES]],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_URL_SECONDS,
  });
  return { id, url, fields, maxBytes: MAX_ATTACHMENTS_BYTES };
}

export async function readUpload(owner: string, id: string): Promise<Buffer> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: env.transferBucketName, Key: uploadKey(owner, id) }));
    if (result.ContentLength !== undefined && result.ContentLength > MAX_ATTACHMENTS_BYTES) throw attachmentsTooLarge();
    return Buffer.from((await result.Body?.transformToByteArray()) ?? []);
  } catch (error) {
    if ((error as Error).name === 'NoSuchKey') {
      throw new HttpError(400, 'upload_missing', 'An attachment upload expired or never finished. Attach the file again.');
    }
    throw error;
  }
}

export async function deleteUploads(owner: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: env.transferBucketName,
      Delete: { Objects: ids.map((id) => ({ Key: uploadKey(owner, id) })), Quiet: true },
    }),
  );
}

export function attachmentsTooLarge(): HttpError {
  return new HttpError(413, 'attachments_too_large', `Attachments may add up to ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB per message.`);
}

/**
 * A presigned URL that downloads one attachment of a stored message. The attachment is extracted
 * (by `load`) into the transfer bucket the first time, and reused while that copy exists.
 */
export async function attachmentDownloadUrl(
  location: { mailbox: string; messageId: string; index: number },
  attachment: AttachmentInfo,
  load: () => Promise<Buffer>,
): Promise<string> {
  const Bucket = env.transferBucketName;
  const Key = `downloads/${encodeURIComponent(location.mailbox)}/${location.messageId}/${location.index}`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
  } catch (error) {
    if ((error as Error).name !== 'NotFound') throw error;
    await s3.send(new PutObjectCommand({ Bucket, Key, Body: await load(), ContentType: 'application/octet-stream' }));
  }
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket,
      Key,
      // Always a download: attachments never render on the bucket's origin.
      ResponseContentDisposition: contentDisposition(attachment.filename),
      ResponseContentType: safeContentType(attachment.contentType),
    }),
    { expiresIn: DOWNLOAD_URL_SECONDS },
  );
}

/** RFC 6266 attachment disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(filename: string): string {
  const name = safeFilename(filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
