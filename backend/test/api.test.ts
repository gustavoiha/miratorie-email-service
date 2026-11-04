import { beforeAll, describe, expect, it } from 'vitest';

let handler: typeof import('../src/handlers/api.js').handler;

beforeAll(async () => {
  Object.assign(process.env, {
    TABLE_NAME: 'messages',
    BUCKET_NAME: 'mail',
    TRANSFER_BUCKET_NAME: 'transfer',
    MAIL_DOMAIN: 'example.com',
    ACCESS_GROUP: 'email-users',
    AWS_REGION: 'eu-central-1',
  });
  ({ handler } = await import('../src/handlers/api.js'));
});

const claims = {
  token_use: 'id',
  'cognito:username': 'alice',
  'cognito:groups': '[email-users mailbox:contact@example.com]',
  name: 'Alice',
  'custom:primary_email': 'alice@example.com',
};

function request(routeKey: string, query?: Record<string, string>, extra: { body?: unknown; pathParameters?: Record<string, string> } = {}) {
  return {
    routeKey,
    queryStringParameters: query,
    pathParameters: extra.pathParameters,
    body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as never;
}

async function call(...args: Parameters<typeof request>) {
  const response = (await handler(request(...args))) as { statusCode: number; body: string };
  return { status: response.statusCode, body: JSON.parse(response.body) as { error?: string } };
}

describe('api handler', () => {
  it('lists the mailboxes the caller can use', async () => {
    const response = (await handler(request('GET /me'))) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      mailbox: 'alice@example.com',
      mailboxes: ['alice@example.com', 'contact@example.com'],
      name: 'Alice',
      domain: 'example.com',
    });
  });

  it('refuses a mailbox the caller does not belong to before touching any data', async () => {
    const response = (await handler(request('GET /messages', { mailbox: 'bob@example.com' }))) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('mailbox_forbidden');
  });

  it('validates attachment requests before touching any data', async () => {
    expect((await call('GET /messages/{id}/attachments/{index}', undefined, { pathParameters: { id: '../x', index: '0' } })).status).toBe(404);
    expect((await call('POST /attachments', undefined, { body: { contentType: 'image/png', size: 26 * 1024 * 1024 } })).body.error).toBe(
      'attachments_too_large',
    );
  });

  it('validates attachments of an outgoing message before touching any data', async () => {
    const message = { to: ['bob@example.org'], subject: 'x', html: '<p>x</p>' };
    const bad = await call('POST /messages', undefined, { body: { ...message, attachments: [{ id: '../../other-user/x' }] } });
    expect(bad).toEqual({ status: 400, body: expect.objectContaining({ error: 'invalid_attachment' }) });

    const many = Array.from({ length: 21 }, () => ({ id: '0b8f4a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', filename: 'a.txt' }));
    expect((await call('POST /messages', undefined, { body: { ...message, attachments: many } })).body.error).toBe('too_many_attachments');

    const forward = await call('POST /messages', undefined, { body: { ...message, forward: { id: '0000000000001-x', attachments: ['0'] } } });
    expect(forward.body.error).toBe('invalid_attachment');
  });
});
