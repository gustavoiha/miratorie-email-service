# TODO

Features and improvements deliberately left out of the first version. Roughly in priority order
within each section.

## Email features

- [ ] **HTML email** – render HTML bodies safely (sanitise server-side, show in a sandboxed
      `iframe` with remote images blocked by default) and allow composing simple HTML.
- [ ] **Attachments: download** – serve attachments through short-lived S3 presigned URLs
      (extract parts on demand or at receive time).
- [ ] **Attachments: send** – upload to S3 with presigned POSTs, then include them when building
      the MIME message (mind the SES 40 MB message limit).
- [ ] Inline images (`cid:`) for HTML messages.
- [ ] Drafts folder with autosave.
- [ ] Conversation/thread view using `Message-ID` / `In-Reply-To` / `References`.
- [ ] Search (subject/from/body), e.g. via an index built at receive time.
- [ ] User-defined folders or labels, and bulk actions (select many, mark read, move).
- [ ] Signatures and per-user preferences.
- [ ] Contacts / address autocomplete from previously used recipients.
- [ ] New-mail notifications (polling, WebSocket API or web push) and unread counts per folder.
- [ ] Aliases and multiple addresses per user; shared mailboxes (e.g. `info@`).
- [ ] Automatic emptying of Trash and Junk after N days.
- [ ] Import/export (mbox / `.eml`).

## Deliverability and mail handling

- [ ] **Bounce and complaint handling** – SES configuration set with an event destination
      (SNS/EventBridge), surface bounces to the sender and maintain a suppression list.
- [ ] **Reject unknown recipients** at SMTP time (synchronous Lambda in the receipt rule that
      stops the rule / bounces) instead of storing mail for addresses nobody owns, or make the
      catch-all behaviour configurable.
- [ ] Per-user sending quotas and rate limits.
- [ ] Parse DMARC aggregate reports into something readable.
- [ ] Optional BIMI record and MTA-STS / TLS-RPT for inbound TLS policy.

## Accounts and security

- [ ] **Send Cognito emails through SES** from `no-reply@<domain>` (branded invitations and
      password resets, and no 50 emails/day limit).
- [ ] TOTP multi-factor authentication.
- [ ] Custom domain for the Cognito sign-in pages (e.g. `login.example.com`).
- [ ] Cognito managed login (v2) branding.
- [ ] Small admin CLI script to add/remove users with the right attributes and group.
- [ ] AWS WAF in front of the API (the web client's distribution can already use an existing web ACL
      through `webAclArn`).
- [ ] Clean up web client builds older than the last few deploys (deploys keep old files on purpose).
- [ ] Optional customer-managed KMS keys for the bucket and table.

## Operations

- [ ] CloudWatch alarms: inbound dead-letter queue not empty, Lambda errors, SES bounce and
      complaint rates.
- [ ] CI (GitHub Actions): typecheck, tests, `cdk synth` on every pull request.
- [ ] End-to-end tests against a deployed test stack.
- [ ] Mailbox storage quotas and usage reporting.
- [ ] Backups/restore runbook (DynamoDB PITR is on; document S3 versioning/replication options).
- [ ] Choose and add a license.
