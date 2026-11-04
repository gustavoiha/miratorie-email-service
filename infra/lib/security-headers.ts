export interface SecurityHeadersOptions {
  /** Origin (or origin pattern) of the API the web client calls. */
  apiOrigin: string;
  /** Origin of the Cognito hosted UI, which the web client calls for tokens. */
  hostedUiUrl: string;
  /** Origin (or origin pattern) of the bucket the web client uploads attachments to. */
  uploadOrigin: string;
}

export function securityHeaders({ apiOrigin, hostedUiUrl, uploadOrigin }: SecurityHeadersOptions): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      // HTML mail is shown in a sandboxed srcdoc iframe, which inherits this policy: it needs inline
      // styles, and https images once the reader chooses to load them. The iframe adds its own,
      // stricter policy on top (no remote images by default, nothing else remote).
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      `connect-src 'self' ${apiOrigin} ${hostedUiUrl} ${uploadOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // A private mailbox has nothing for search engines to index.
    'x-robots-tag': 'noindex, nofollow',
  };
}

/** Viewer-response CloudFront Function (cloudfront-js-2.0) that sets `headers` on every response it sees. */
export function securityHeadersFunctionCode(headers: Record<string, string>): string {
  return `
var HEADERS = ${JSON.stringify(headers)};
function handler(event) {
  var response = event.response;
  for (var name in HEADERS) {
    response.headers[name] = { value: HEADERS[name] };
  }
  return response;
}
`.trim();
}
