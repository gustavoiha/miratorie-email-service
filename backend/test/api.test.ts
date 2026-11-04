import { beforeAll, describe, expect, it } from 'vitest';

let handler: typeof import('../src/handlers/api.js').handler;

beforeAll(async () => {
  Object.assign(process.env, {
    TABLE_NAME: 'messages',
    BUCKET_NAME: 'mail',
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

function request(routeKey: string, query?: Record<string, string>) {
  return { routeKey, queryStringParameters: query, requestContext: { authorizer: { jwt: { claims, scopes: [] } } } } as never;
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
});
