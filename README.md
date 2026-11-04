# miratorie-email-service

An open-source email service with sending and receiving, self-hosted on AWS. Bring a domain you own,
deploy three CDK stacks, and get mailboxes such as `alice@example.com` with a small web client.

- **Sending:** SES (Easy DKIM, custom MAIL FROM) · **Receiving:** SES receipt rule → S3 → Lambda
- **Storage:** S3 (raw `.eml`) + DynamoDB (mailbox index) · **API:** HTTP API + Lambda
- **Users:** Cognito (admin-created, access group) · **Web client:** React on S3 + CloudFront
- **DNS:** any provider; the records are stack outputs

Plain-text email only for now; see [TODO.md](TODO.md). More detail in [docs/](docs/):
[architecture](docs/architecture.md), [DNS](docs/dns.md), [users](docs/users.md),
[custom domains](docs/custom-domains.md), [troubleshooting](docs/troubleshooting.md).

| Stack           | Contents                                                              | On destroy             |
| --------------- | --------------------------------------------------------------------- | ---------------------- |
| `<prefix>-Mail` | SES identity and receipt rules, mail bucket, DynamoDB, inbound Lambda | Bucket, table retained |
| `<prefix>-Auth` | Cognito user pool, access group, sign-in domain                       | User pool retained     |
| `<prefix>-App`  | CloudFront web client, Cognito app client, HTTP API, API Lambda       | Removed                |

## Prerequisites

- A domain whose DNS you control. Nothing else may receive mail for it once the MX points to SES.
- AWS CLI credentials able to deploy CloudFormation, and Node.js 22+.
- A region with [SES email receiving](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints).
  Only one receipt rule set can be active per region; deploying activates this one.
- Optional: ACM certificates for custom web client and API domains (`us-east-1` and the deployment
  region).

## 1. Configure

```bash
npm ci
cp infra/config.example.json infra/config.json
```

| Key                           | Required   | Description                                                                         |
| ----------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `domainName`                  | yes        | Mailbox domain, e.g. `example.com`                                                  |
| `region`                      | yes        | Region with SES receiving; all stacks deploy here                                   |
| `cognitoDomainPrefix`         | yes        | Globally unique sign-in prefix; no `aws`, `amazon`, `cognito`                       |
| `stackPrefix`                 | no         | Stack name prefix. Default `MiratorieEmail`                                         |
| `account`                     | no         | Defaults to the CLI account                                                         |
| `mailFromSubdomain`           | no         | MAIL FROM label. Default `mail`                                                     |
| `dmarc.policy`                | no         | `none`, `quarantine` (default), `reject`                                            |
| `dmarc.reportEmail`           | no         | DMARC aggregate report address (`rua`)                                              |
| `activateReceiptRuleSet`      | no         | Activate this receipt rule set. Default `true`                                      |
| `accessGroupName`             | no         | Cognito group allowed to use the service. Default `email-users`                     |
| `web.domainName`              | no         | Custom web client domain; omit `web` to use `*.cloudfront.net`                      |
| `web.certificateArnParameter` | with `web` | SSM parameter (deployment region) holding the `us-east-1` certificate ARN           |
| `api.domainName`              | no         | Custom API domain; disables the `execute-api` URL                                   |
| `api.certificateArnParameter` | with `api` | SSM parameter (deployment region) holding a certificate ARN in the deployment region |
| `webAclArn`                   | no         | Existing CloudFront web ACL; required once on a flat-rate plan                      |
| `localDevOrigins`             | no         | Extra allowed origins. Default `["http://localhost:5173"]`                          |
| `rawInboundRetentionDays`     | no         | Retention of raw inbound copies. Default `30`                                       |

For custom domains, create the certificates and SSM parameters first:
[docs/custom-domains.md](docs/custom-domains.md).

## 2. Deploy

```bash
npx -w infra cdk bootstrap   # once per account and region
npm run deploy               # builds the web client, deploys all stacks, writes infra/cdk-outputs.json
```

`npm run diff` previews changes. Key outputs: `Dns*` (Mail), `UserPoolId` (Auth), `WebUrl` and
`DistributionDomain`, `ApiUrl`, `ApiDomainTarget` (App).

## 3. DNS

Create these records at your DNS provider, using the exact values from the `Dns*` outputs
(example: `example.com` in `us-east-1`):

| Name                              | Type  | Value                                                                   |
| --------------------------------- | ----- | ----------------------------------------------------------------------- |
| `<token1..3>._domainkey.example.com` | CNAME | `<token1..3>.dkim.amazonses.com` (`DnsDkim1..3`)                     |
| `example.com`                     | MX    | `10 inbound-smtp.us-east-1.amazonaws.com` (`DnsInboundMx`)              |
| `mail.example.com`                | MX    | `10 feedback-smtp.us-east-1.amazonses.com` (`DnsMailFromMx`)            |
| `mail.example.com`                | TXT   | `"v=spf1 include:amazonses.com ~all"` (`DnsMailFromSpf`)                |
| `example.com`                     | TXT   | `"v=spf1 include:amazonses.com ~all"` (`DnsApexSpf`)                    |
| `_dmarc.example.com`              | TXT   | `"v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:…"` (`DnsDmarc`)  |
| `web.domainName` (if set)         | CNAME | `DistributionDomain` output                                             |
| `api.domainName` (if set)         | CNAME | `ApiDomainTarget` output                                                |

All records DNS-only. Merge with an existing SPF record instead of adding a second one, and remove
other MX records. Print the outputs and check the SES status:

```bash
aws cloudformation describe-stacks --stack-name MiratorieEmail-Mail \
  --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Dns')].[OutputKey, OutputValue]" --output table
aws sesv2 get-email-identity --email-identity example.com \
  --query '{verified: VerifiedForSendingStatus, dkim: DkimAttributes.Status, mailFrom: MailFromAttributes.MailFromDomainStatus}'
```

Expect `true`, `SUCCESS`, `SUCCESS`. DMARC rollout and provider notes: [docs/dns.md](docs/dns.md).

## 4. SES production access

The SES sandbox only sends to verified addresses. Request production access once DNS verifies:

```bash
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://example.com --contact-language EN \
  --use-case-description "Person-to-person mailboxes for example.com"
```

Meanwhile, verify test recipients with `aws sesv2 create-email-identity --email-identity <address>`.

## 5. Add users

Users are created by the operator; there is no sign-up. `custom:primary_email` is the mailbox;
`email` is the secondary address that receives the invitation and password-reset codes.

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name MiratorieEmail-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username alice@example.com \
  --user-attributes Name=name,Value="Alice Smith" Name=phone_number,Value=+447700900123 \
    Name=custom:primary_email,Value=alice@example.com \
    Name=email,Value=alice.personal@gmail.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL

aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" \
  --username alice@example.com --group-name email-users
```

The user signs in at `WebUrl` and sets a password. Other user tasks: [docs/users.md](docs/users.md).

## Development

```bash
npm test                            # unit and infrastructure tests
npm run typecheck
npm run synth
npm run config:local -w frontend    # after a deploy: frontend/public/config.json from stack outputs
npm run dev                         # web client on http://localhost:5173 against the deployed API
```

Layout: `backend/` Lambda handlers, `frontend/` React + Vite client, `infra/` CDK app, `docs/` details.

## Update and remove

Update with `npm run deploy`. `npm run destroy -w infra` removes the stacks but retains the mail
bucket, the messages table and the user pool; delete those manually if needed, and remove the DNS
records (at least the MX).
