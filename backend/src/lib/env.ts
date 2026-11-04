function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Configuration injected by the CDK stacks. Read lazily so tests can import modules freely. */
export const env = {
  get tableName() {
    return required('TABLE_NAME');
  },
  get tableIndex() {
    return process.env.TABLE_INDEX ?? 'byFolder';
  },
  get bucketName() {
    return required('BUCKET_NAME');
  },
  get mailDomain() {
    return required('MAIL_DOMAIN').toLowerCase();
  },
  get accessGroup() {
    return required('ACCESS_GROUP');
  },
  /** Short-lived uploads and downloads of attachments (API only). */
  get transferBucketName() {
    return required('TRANSFER_BUCKET_NAME');
  },
  get inboundPrefix() {
    return process.env.INBOUND_PREFIX ?? 'inbound/';
  },
};
