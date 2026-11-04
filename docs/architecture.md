# Architecture

```mermaid
flowchart LR
  subgraph Internet
    sender[Other mail servers]
    rcpt[Recipients]
    browser[Browser]
  end

  subgraph Mail stack
    sesIn[SES receipt rule]
    bucket[(S3 mail bucket)]
    inbound[Lambda: inbound processor]
    table[(DynamoDB messages)]
    sesOut[SES domain identity]
  end

  subgraph Auth stack
    cognito[Cognito user pool<br/>+ access group]
  end

  subgraph App stack
    cf[CloudFront + S3<br/>web client]
    api[HTTP API<br/>JWT authorizer]
    apiFn[Lambda: API]
    transfer[(S3 transfer bucket<br/>1-day expiry)]
  end

  sender -- SMTP via MX --> sesIn
  sesIn -- 1. store raw --> bucket
  sesIn -- 2. invoke --> inbound
  inbound -- copy per mailbox --> bucket
  inbound -- index --> table

  browser --> cf
  browser -- sign in --> cognito
  browser -- ID token --> api --> apiFn
  apiFn --> table
  apiFn --> bucket
  apiFn --> transfer
  browser -- presigned upload / download --> transfer
  apiFn -- SendEmail --> sesOut --> rcpt
```

## Receiving

The domain's MX points to SES. The receipt rule accepts mail for any address on the domain, runs
the spam and virus scan, then:

1. **S3 action** stores the raw message at `inbound/<SES message id>` (kept `rawInboundRetentionDays`).
2. **Lambda action** (asynchronous) runs the inbound processor, which copies the message to
   `mailboxes/<address>/<id>.eml` for each recipient on the domain and writes one DynamoDB item per
   copy. Failures are retried twice, then sent to the `InboundDeadLetterQueueUrl` queue.

Virus `FAIL` is dropped; spam or DMARC `FAIL` goes to Junk. Mail to addresses with no user is still
stored and becomes visible to a user later created with that `custom:primary_email`. Nothing polls:
SES pushes events, and the web client refreshes on navigation or on *Refresh*.

## Sending

Synchronous, no queue. The web client's editor produces simple HTML (formatting, lists, quotes,
links); the API sanitises it again and sends `multipart/alternative` with a plain-text rendering,
plus any attachments. The API Lambda builds the MIME message, calls SES `SendEmail` (raw; the SDK
retries throttling and transient errors), and only after SES accepts it stores the copy in S3 and the
Sent item in DynamoDB. SES rejections return `422`, throttling `429`. After acceptance SES retries
delivery; bounces and complaints reach the sender's inbox through SES feedback forwarding and are
otherwise unhandled (see TODO).

SES signs with DKIM and uses `mail.<domain>` as MAIL FROM, so SPF and DKIM both align with `From:`.

## HTML mail

`GET /messages/{id}` returns the HTML body sanitised server-side (`sanitize-html`): scripts, event
handlers, forms, frames, embeds, `javascript:` and relative URLs are removed, links get
`target="_blank" rel="noopener noreferrer"`, and inline `cid:` images become data: URLs (up to 2 MB per
message; larger ones are left as attachments). Bodies over 2 MB fall back to plain text.

The web client renders it in an `iframe srcdoc` with `sandbox="allow-same-origin allow-popups
allow-popups-to-escape-sandbox"`: no scripts, forms or top-level navigation; same-origin only lets
the page measure the content to size the frame. A `srcdoc` frame inherits the app's CSP, so the app
allows inline styles and https images; the frame adds its own CSP (`default-src 'none'`, inline styles,
`img-src data:`), which blocks remote images, CSS backgrounds, fonts and stylesheets until the reader
clicks *Show images* (then `img-src data: https:`). Replies and forwards quote the original as text.

## Attachments

Attachments pass through the App stack's transfer bucket, whose objects expire after a day:

- **Send:** `POST /attachments` returns a presigned POST for `uploads/<user>/<upload id>` (15 minutes,
  ≤ 25 MB); the browser posts the file straight to S3 (CORS allows only the web client origins). The
  send request names the uploads; the API reads them, checks the total (≤ 25 MB, about 35 MB once
  encoded, under the SES 40 MB limit; at most 20 files), attaches them and deletes the uploads.
  Forwarding re-attaches chosen attachments of the original from the stored message.
- **Download:** `GET /messages/{id}/attachments/{index}` extracts the attachment from the stored
  message into `downloads/<mailbox>/<id>/<index>` (reused while it exists) and returns a presigned GET
  valid for 5 minutes that always downloads (`Content-Disposition: attachment`).

The API Lambda bundles the AWS SDK (for the presigners) and has 1.5 GB and 29 s for large messages.

## Access

The HTTP API validates Cognito ID tokens. The Lambda also requires membership of the access group
and serves only the caller's mailboxes: their own (`custom:primary_email`, which the app client
cannot write) and every collective address whose Cognito group `mailbox:<address>` they belong to.
Groups come from the ID token, so membership changes apply at the next token refresh.

Collective mail is stored once under its address, like any mailbox, so members share its folders and
read state. Sending from a collective address uses the member's name with that address, and the copy
goes to that mailbox's Sent folder.

## Stacks

| Stack           | Contents                                                                                       | On destroy            |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| `<prefix>-Mail` | SES identity, receipt rule set, mail bucket, DynamoDB table, inbound Lambda + DLQ, DNS outputs | Bucket, table retained |
| `<prefix>-Auth` | Cognito user pool, access group, hosted sign-in domain                                         | User pool retained    |
| `<prefix>-App`  | CloudFront + site bucket, Cognito app client, HTTP API, API Lambda, transfer bucket            | Removed               |

## API

All routes require `Authorization: Bearer <Cognito ID token>`. Message routes take `?mailbox=<address>`
(default: the caller's first mailbox) and answer `403 mailbox_forbidden` for mailboxes the caller
cannot use.

| Route                   | Description                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /me`               | `{ mailbox, mailboxes, name, domain }`; `mailboxes` lists own and collective addresses           |
| `GET /messages`         | `?folder=INBOX\|SENT\|JUNK\|TRASH&limit=1..100&cursor=…` → `{ messages, cursor? }`, newest first |
| `GET /messages/{id}`    | Message with `text` and sanitised `html?` bodies (parsed from S3 on each read)                  |
| `GET /messages/{id}/attachments/{index}` | `{ url, filename }`: presigned download, valid 5 minutes                         |
| `POST /attachments`     | `{ contentType, size? }` → `{ id, url, fields, maxBytes }`: presigned POST for one upload        |
| `POST /messages`        | `{ to, cc?, bcc?, subject, html \| text, inReplyTo?, attachments?: [{ id, filename, contentType }], forward?: { id, attachments: [index] } }`; ≤ 50 recipients, ≤ 20 attachments, ≤ 25 MB |
| `PATCH /messages/{id}`  | `{ read?, folder? }`                                                                             |
| `DELETE /messages/{id}` | Permanent delete; message must be in `TRASH`                                                    |

## Data model

| Key                | Attribute   | Format                                                                                  |
| ------------------ | ----------- | --------------------------------------------------------------------------------------- |
| Table partition    | `mailbox`   | `alice@example.com`                                                                     |
| Table sort         | `id`        | `<13-digit epoch ms>-<SES message id \| UUID>` (chronological; idempotent inbound retries) |
| `byFolder` partition | `folderKey` | `<mailbox>#<FOLDER>`                                                                  |
| `byFolder` sort    | `id`        | as above                                                                                |

Items hold the summary (from, to, cc, bcc, subject, snippet, date, read, attachments in MIME order,
verdicts), the threading headers (`messageIdHeader`, `references`) and `s3Key`; the body is read
from `mailboxes/<mailbox>/<id>.eml`. There is no TTL: mail is only deleted by the user.
