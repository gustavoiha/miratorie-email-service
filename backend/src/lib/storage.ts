import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

const s3 = new S3Client({});

export async function getRawMessage(key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: env.bucketName, Key: key }));
  if (!result.Body) throw new Error(`Empty object ${key}`);
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function putRawMessage(key: string, raw: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: env.bucketName, Key: key, Body: raw, ContentType: 'message/rfc822' }));
}

export async function copyRawMessage(sourceKey: string, targetKey: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: env.bucketName,
      CopySource: `${env.bucketName}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      Key: targetKey,
      ContentType: 'message/rfc822',
      MetadataDirective: 'REPLACE',
    }),
  );
}

export async function deleteRawMessage(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.bucketName, Key: key }));
}
