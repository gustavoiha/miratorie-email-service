import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface EmailServiceConfig {
  /** Prefix for every stack name, so several deployments can live in one account. */
  stackPrefix: string;
  /** AWS account to deploy to. Defaults to the account of the current CLI credentials. */
  account?: string;
  /** AWS region. Must be a region where SES email receiving is available. */
  region: string;
  /** The domain the mailboxes live on, e.g. "example.com" for "alice@example.com". */
  domainName: string;
  /** Subdomain used as the custom MAIL FROM domain, e.g. "mail" -> "mail.example.com". */
  mailFromSubdomain: string;
  dmarc: {
    policy: DmarcPolicy;
    /** Optional address that receives aggregate DMARC reports (rua). */
    reportEmail?: string;
  };
  /**
   * Only one SES receipt rule set can be active per account and region. When true, the stack
   * activates its own rule set (deactivating any other one).
   */
  activateReceiptRuleSet: boolean;
  /** Globally unique prefix for the Cognito hosted sign-in domain: https://<prefix>.auth.<region>.amazoncognito.com */
  cognitoDomainPrefix: string;
  /** Cognito group whose members may use the email service. */
  accessGroupName: string;
  /** Custom domain of the web client. Without it the client is served on its *.cloudfront.net domain. */
  web?: {
    /** e.g. "webmail.example.com". */
    domainName: string;
    /** SSM parameter, in the deployment region, holding the ARN of a us-east-1 ACM certificate for `domainName`. */
    certificateArnParameter: string;
  };
  /** Custom domain of the API. Without it the API is served on its *.execute-api domain. */
  api?: {
    /** e.g. "webmail-api.example.com". */
    domainName: string;
    /** SSM parameter, in the deployment region, holding the ARN of an ACM certificate for `domainName` in that region. */
    certificateArnParameter: string;
  };
  /** Existing CloudFront (us-east-1, global) WAF web ACL to attach to the web client's distribution. */
  webAclArn?: string;
  /** Extra origins allowed to sign in and call the API, e.g. the Vite dev server. */
  localDevOrigins: string[];
  /** Days to keep raw inbound messages under inbound/ in the mail bucket (they are copied per mailbox). */
  rawInboundRetentionDays: number;
}

const DEFAULTS = {
  stackPrefix: 'MiratorieEmail',
  mailFromSubdomain: 'mail',
  dmarc: { policy: 'quarantine' as DmarcPolicy },
  activateReceiptRuleSet: true,
  accessGroupName: 'email-users',
  localDevOrigins: ['http://localhost:5173'],
  rawInboundRetentionDays: 30,
};

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseConfig(raw: unknown): EmailServiceConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Config must be a JSON object.');
  }
  const input = raw as Record<string, any>;
  const errors: string[] = [];

  const domainName = String(input.domainName ?? '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domainName)) errors.push('"domainName" must be a valid domain such as "example.com".');

  const region = String(input.region ?? process.env.CDK_DEFAULT_REGION ?? '').trim();
  if (!region) errors.push('"region" is required.');

  const cognitoDomainPrefix = String(input.cognitoDomainPrefix ?? '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cognitoDomainPrefix) || /aws|amazon|cognito/.test(cognitoDomainPrefix)) {
    errors.push('"cognitoDomainPrefix" must be lowercase letters, digits and hyphens, and must not contain "aws", "amazon" or "cognito".');
  }

  const dmarcPolicy = (input.dmarc?.policy ?? DEFAULTS.dmarc.policy) as DmarcPolicy;
  if (!['none', 'quarantine', 'reject'].includes(dmarcPolicy)) errors.push('"dmarc.policy" must be "none", "quarantine" or "reject".');

  const mailFromSubdomain = String(input.mailFromSubdomain ?? DEFAULTS.mailFromSubdomain).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(mailFromSubdomain)) errors.push('"mailFromSubdomain" must be a single DNS label such as "mail".');

  let web: EmailServiceConfig['web'];
  if (input.web !== undefined) {
    web = {
      domainName: String(input.web?.domainName ?? '').trim().toLowerCase(),
      certificateArnParameter: String(input.web?.certificateArnParameter ?? '').trim(),
    };
    if (!DOMAIN_RE.test(web.domainName)) errors.push('"web.domainName" must be a valid domain such as "webmail.example.com".');
    else if (web.domainName === `${mailFromSubdomain}.${domainName}`) {
      errors.push('"web.domainName" must differ from the MAIL FROM domain, which needs its own MX and TXT records.');
    }
    if (!web.certificateArnParameter) errors.push('"web.certificateArnParameter" is required with "web.domainName".');
  }

  let api: EmailServiceConfig['api'];
  if (input.api !== undefined) {
    api = {
      domainName: String(input.api?.domainName ?? '').trim().toLowerCase(),
      certificateArnParameter: String(input.api?.certificateArnParameter ?? '').trim(),
    };
    if (!DOMAIN_RE.test(api.domainName)) errors.push('"api.domainName" must be a valid domain such as "webmail-api.example.com".');
    else if (api.domainName === `${mailFromSubdomain}.${domainName}` || api.domainName === web?.domainName) {
      errors.push('"api.domainName" must differ from the MAIL FROM domain and from "web.domainName".');
    }
    if (!api.certificateArnParameter) errors.push('"api.certificateArnParameter" is required with "api.domainName".');
  }

  const webAclArn = input.webAclArn ? String(input.webAclArn).trim() : undefined;
  if (webAclArn && !/^arn:aws:wafv2:us-east-1:\d{12}:global\/webacl\//.test(webAclArn)) {
    errors.push('"webAclArn" must be the ARN of a CloudFront (global, us-east-1) WAF web ACL.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid email service config:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    stackPrefix: String(input.stackPrefix ?? DEFAULTS.stackPrefix),
    account: input.account ? String(input.account) : process.env.CDK_DEFAULT_ACCOUNT,
    region,
    domainName,
    mailFromSubdomain,
    dmarc: {
      policy: dmarcPolicy,
      reportEmail: input.dmarc?.reportEmail ? String(input.dmarc.reportEmail) : undefined,
    },
    activateReceiptRuleSet: input.activateReceiptRuleSet ?? DEFAULTS.activateReceiptRuleSet,
    cognitoDomainPrefix,
    accessGroupName: String(input.accessGroupName ?? DEFAULTS.accessGroupName),
    web,
    api,
    webAclArn,
    localDevOrigins: Array.isArray(input.localDevOrigins) ? input.localDevOrigins.map(String) : DEFAULTS.localDevOrigins,
    rawInboundRetentionDays: Number(input.rawInboundRetentionDays ?? DEFAULTS.rawInboundRetentionDays),
  };
}

/** Reads infra/config.json. */
export function loadConfig(infraDir: string): EmailServiceConfig {
  const path = resolve(infraDir, 'config.json');
  if (!existsSync(path)) {
    throw new Error(`Config file not found at ${path}. Copy infra/config.example.json to infra/config.json and fill it in.`);
  }
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

