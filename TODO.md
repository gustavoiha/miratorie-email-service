# TODO

Features and improvements deliberately left out of the first version. Roughly in priority order
within each section.

## Email features

- [ ] Drafts folder with autosave.
- [ ] Conversation/thread view using `Message-ID` / `In-Reply-To` / `References`. Replies trim
      `References` to the last 20 ids, which drops the conversation's root; keep the first one.
- [ ] Signatures and per-user preferences.
- [ ] Contacts / address autocomplete from previously used recipients.
- [ ] Automatic emptying of Trash and Junk after N days.

## Web client

- [ ] Show all received emails in the same screen/inbox if user participates in a collective mailbox, so that they see received emails without having to select each mailbox individually.

## Deliverability and mail handling

- [ ] **Bounce and complaint handling** – SES configuration set with an event destination
      (SNS/EventBridge), surface bounces to the sender and maintain a suppression list.
- [ ] **Reject unknown recipients** at SMTP time (synchronous Lambda in the receipt rule that
      stops the rule / bounces) instead of storing mail for addresses nobody owns, or make the
      catch-all behaviour configurable.
- [ ] Parse DMARC aggregate reports into something readable.
- [ ] Optional BIMI record and MTA-STS / TLS-RPT for inbound TLS policy.

## Accounts and security

- [ ] **Send Cognito emails through SES** from `no-reply@<domain>` (branded invitations and
      password resets, and no 50 emails/day limit).
- [ ] TOTP multi-factor authentication.
- [ ] Custom domain for the Cognito sign-in pages (e.g. `auth.example.com`).
- [ ] Cognito managed login (v2) branding.
- [ ] AWS WAF in front of the API (the web client's distribution can already use an existing web ACL
      through `webAclArn`).
- [ ] Clean up web client builds older than the last few deploys (deploys keep old files on purpose).

## Operations

- [ ] CloudWatch alarms: inbound dead-letter queue not empty, Lambda errors, SES bounce and
      complaint rates.
- [ ] CI (GitHub Actions): typecheck, tests, `cdk synth` on every pull request.
- [ ] End-to-end tests against a deployed test stack.
- [ ] Mailbox storage quotas and usage reporting.
- [ ] Backups/restore runbook (DynamoDB PITR is on; document S3 versioning/replication options).
- [ ] Choose and add a license.

## Ideas not for now
- [ ] New-mail notifications (polling, WebSocket API or web push) and unread counts per folder.
- [ ] Aliases and multiple addresses per user.
- [ ] Per-user sending quotas and rate limits.
- [ ] Small admin CLI script to add/remove users with the right attributes and group.
- [ ] Optional customer-managed KMS keys for the bucket and table.
- [ ] Import/export (mbox / `.eml`).
- [ ] Search (subject/from/body), e.g. via an index built at receive time.
- [ ] User-defined folders or labels, and bulk actions (select many, mark read, move).
- [ ] Composer: inline images
- [ ] Composer: quote the original's HTML (not just its text) in replies and forwards.
- [ ] Inline (`cid:`) images beyond the 2 MB per-message budget, served through presigned URLs.
