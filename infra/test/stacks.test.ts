import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { parseConfig } from '../lib/config.js';
import { securityHeaders, securityHeadersFunctionCode } from '../lib/security-headers.js';
import { MailStack } from '../lib/mail-stack.js';

const customWeb = {
  web: { domainName: 'webmail.example.com', certificateArnParameter: '/example/certificate-arn' },
  api: { domainName: 'webmail-api.example.com', certificateArnParameter: '/example/api-certificate-arn' },
  webAclArn: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/CreatedByCloudFront-abc/0fa82f20-12c7-45f6-bdbd-ef9743e8246a',
};

const baseConfig = {
  region: 'us-east-1',
  account: '123456789012',
  domainName: 'Example.com',
  cognitoDomainPrefix: 'example-com-mail',
  dmarc: { policy: 'reject', reportEmail: 'dmarc@example.com' },
};

describe('parseConfig', () => {
  it('applies defaults and normalises the domain', () => {
    const config = parseConfig(baseConfig);
    expect(config.domainName).toBe('example.com');
    expect(config.accessGroupName).toBe('email-users');
    expect(config.mailFromSubdomain).toBe('mail');
  });

  it('rejects invalid values', () => {
    expect(() => parseConfig({ ...baseConfig, domainName: 'not a domain' })).toThrow(/domainName/);
    expect(() => parseConfig({ ...baseConfig, cognitoDomainPrefix: 'my-cognito' })).toThrow(/cognitoDomainPrefix/);
    expect(() => parseConfig({ ...baseConfig, dmarc: { policy: 'strict' } })).toThrow(/dmarc/);
    expect(() => parseConfig({ ...baseConfig, web: { domainName: 'webmail.example.com' } })).toThrow(/certificateArnParameter/);
    expect(() => parseConfig({ ...baseConfig, web: { ...customWeb.web, domainName: 'mail.example.com' } })).toThrow(/MAIL FROM/);
    expect(() => parseConfig({ ...baseConfig, api: { domainName: 'webmail-api.example.com' } })).toThrow(/api.certificateArnParameter/);
    expect(() => parseConfig({ ...baseConfig, ...customWeb, api: { ...customWeb.api, domainName: 'webmail.example.com' } })).toThrow(
      /api.domainName/,
    );
    expect(() => parseConfig({ ...baseConfig, webAclArn: 'arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/x/y' })).toThrow(/webAclArn/);
  });
});

function synth(input: Record<string, unknown>) {
  const config = parseConfig(input);
  const dist = mkdtempSync(join(tmpdir(), 'frontend-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');

  const app = new App();
  const env = { account: config.account, region: config.region };
  const mailStack = new MailStack(app, 'Test-Mail', { env, config });
  const authStack = new AuthStack(app, 'Test-Auth', { env, config });
  const appStack = new AppStack(app, 'Test-App', {
    env,
    config,
    mailBucket: mailStack.mailBucket,
    messagesTable: mailStack.messagesTable,
    userPool: authStack.userPool,
    userPoolDomain: authStack.userPoolDomain,
    frontendDistPath: dist,
  });
  return { mail: Template.fromStack(mailStack), auth: Template.fromStack(authStack), web: Template.fromStack(appStack) };
}

describe('web client distribution', () => {
  it('serves on the CloudFront domain by default, with security headers from a function', () => {
    const { web } = synth(baseConfig);
    const distribution = Object.values(web.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    expect(distribution.Aliases).toBeUndefined();
    expect(distribution.WebACLId).toBeUndefined();
    expect(distribution.DefaultCacheBehavior.Compress).toBe(true);
    web.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    expect(distribution.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-response', FunctionARN: { 'Fn::GetAtt': [expect.stringMatching(/^SecurityHeaders/), 'FunctionARN'] } },
    ]);
    web.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      AutoPublish: true,
    });
    web.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    web.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: false });
  }, 120_000);

  it('uses the custom domain, the certificate from SSM and the web ACL', () => {
    const { web } = synth({ ...baseConfig, ...customWeb });
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['webmail.example.com'],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: { Ref: Match.stringLikeRegexp('SsmParameterValue') } }),
        WebACLId: customWeb.webAclArn,
      }),
    });
    expect(Object.values(web.toJSON().Parameters).some((parameter: any) => parameter.Default === '/example/certificate-arn')).toBe(true);
    web.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://webmail.example.com/', 'http://localhost:5173/'],
    });
  }, 120_000);

  it('serves the API only on its custom domain, with a certificate from SSM', () => {
    const { web } = synth({ ...baseConfig, ...customWeb });
    const parameters = web.toJSON().Parameters as Record<string, { Default: string }>;
    const apiCertificateParameter = Object.keys(parameters).find((key) => parameters[key]!.Default === '/example/api-certificate-arn');
    web.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'webmail-api.example.com',
      DomainNameConfigurations: [Match.objectLike({ CertificateArn: { Ref: apiCertificateParameter }, EndpointType: 'REGIONAL' })],
    });
    web.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
    web.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: true });
    expect(web.findOutputs('ApiUrl').ApiUrl!.Value).toBe('https://webmail-api.example.com');
    const code = JSON.stringify(Object.values(web.findResources('AWS::CloudFront::Function'))[0]!.Properties.FunctionCode);
    expect(code).toContain("connect-src 'self' https://webmail-api.example.com https://");
    expect(code).not.toContain('execute-api');
  }, 120_000);
});

describe('stacks', () => {
  let mail: Template;
  let auth: Template;
  let web: Template;

  beforeAll(() => {
    ({ mail, auth, web } = synth(baseConfig));
  }, 120_000);

  it('receives mail for the domain into S3 and the inbound function', () => {
    mail.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: Match.objectLike({
        Recipients: ['example.com'],
        ScanEnabled: true,
        Actions: [Match.objectLike({ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbound/' }) }), Match.objectLike({ LambdaAction: Match.anyValue() })],
      }),
    });
    mail.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'example.com',
      MailFromAttributes: { MailFromDomain: 'mail.example.com', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' },
    });
  });

  it('outputs the DNS records instead of managing DNS', () => {
    mail.resourceCountIs('AWS::Route53::RecordSet', 0);
    expect(mail.findOutputs('DnsDmarc').DnsDmarc!.Value).toBe(
      '_dmarc.example.com TXT "v=DMARC1; p=reject; adkim=r; aspf=r; rua=mailto:dmarc@example.com"',
    );
    expect(mail.findOutputs('DnsInboundMx').DnsInboundMx!.Value).toBe('example.com MX 10 inbound-smtp.us-east-1.amazonaws.com');
    expect(mail.findOutputs('DnsMailFromSpf').DnsMailFromSpf!.Value).toBe('mail.example.com TXT "v=spf1 include:amazonses.com ~all"');
    expect(Object.keys(mail.findOutputs('*')).filter((key) => key.startsWith('DnsDkim'))).toHaveLength(3);
  });

  it('keeps mail data when the stack is deleted', () => {
    mail.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    mail.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    auth.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
  });

  it('configures the user pool for admin-created users with email recovery', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      Schema: Match.arrayWith([Match.objectLike({ Name: 'primary_email', AttributeDataType: 'String', Mutable: true })]),
    });
    auth.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'email-users' });
  });

  it('does not let users change their own mailbox address', () => {
    const clients = web.findResources('AWS::Cognito::UserPoolClient');
    const client = Object.values(clients)[0]!.Properties;
    expect(client.ReadAttributes).toContain('custom:primary_email');
    expect(client.WriteAttributes).not.toContain('custom:primary_email');
  });

  it('protects every API route with the Cognito authorizer', () => {
    const routes = Object.values(web.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(6);
    for (const route of routes) expect(route.Properties.AuthorizationType).toBe('JWT');
  });
});

describe('security headers function', () => {
  it('sets every header on the response, replacing existing values', () => {
    const headers = securityHeaders({
      apiOrigin: 'https://*.execute-api.eu-west-1.amazonaws.com',
      hostedUiUrl: 'https://prefix.auth.eu-west-1.amazoncognito.com',
    });
    const handler = new Function(`${securityHeadersFunctionCode(headers)}; return handler;`)() as (event: unknown) => {
      headers: Record<string, { value: string }>;
    };
    const response = handler({
      response: { statusCode: 200, headers: { 'content-type': { value: 'text/html' }, 'x-frame-options': { value: 'SAMEORIGIN' } } },
    });
    expect(response.headers['content-type']).toEqual({ value: 'text/html' });
    expect(response.headers['x-frame-options']).toEqual({ value: 'DENY' });
    expect(response.headers['x-robots-tag']).toEqual({ value: 'noindex, nofollow' });
    expect(response.headers['content-security-policy']!.value).toContain(
      "connect-src 'self' https://*.execute-api.eu-west-1.amazonaws.com https://prefix.auth.eu-west-1.amazoncognito.com",
    );
  });
});
