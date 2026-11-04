import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResultV2 {
  return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
}

export function parseJsonBody(body: string | undefined, isBase64Encoded: boolean): Record<string, unknown> {
  if (!body) throw new HttpError(400, 'invalid_body', 'A JSON body is required.');
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_body', 'The body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_body', 'The body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}
