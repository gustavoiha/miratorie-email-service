# Troubleshooting

- **Cognito domain taken** – choose another `cognitoDomainPrefix`.
- **SES identity stays unverified** – compare `dig` results with the `Dns*` outputs (see [dns.md](dns.md)).
- **No mail arrives** – check `dig MX <domain>`, `aws ses describe-active-receipt-rule-set`, the
  inbound Lambda logs and the `InboundDeadLetterQueueUrl` queue. Raw messages stay under `inbound/`.
- **"Email address is not verified" when sending** – SES sandbox: verify the recipient or request
  production access.
- **"Not granted access"** – add the user to the access group, then sign in again.
- **"No mailbox"** – set `custom:primary_email` to an address on the domain.
- **Sent mail lands in spam** – check SPF/DKIM/DMARC in the received headers and leave the sandbox;
  new domains need time to build reputation.
- **Attachment upload fails** – the browser posts straight to the transfer bucket: check the browser
  console for a CORS or CSP error (the web client's origin must be the `WebUrl` or in
  `localDevOrigins`). Uploads expire after a day; attach again if sending reports `upload_missing`.
- **Deploy fails removing a web ACL** – set `webAclArn` (see [custom-domains.md](custom-domains.md)).
