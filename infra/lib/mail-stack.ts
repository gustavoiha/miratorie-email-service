import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { backendFunction } from './backend-function.js';
import type { EmailServiceConfig } from './config.js';

export const INBOUND_PREFIX = 'inbound/';
export const MAILBOX_INDEX = 'byFolder';

export interface MailStackProps extends StackProps {
  config: EmailServiceConfig;
}

/**
 * The stateful core of the service: the SES domain identity (sending), the SES receipt rules
 * (receiving), the S3 bucket holding raw messages and the DynamoDB table indexing them.
 * DNS is managed outside AWS: the required records are exposed as stack outputs.
 */
export class MailStack extends Stack {
  readonly mailBucket: s3.Bucket;
  readonly messagesTable: dynamodb.TableV2;
  readonly emailIdentity: ses.EmailIdentity;

  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, props);
    const { config } = props;
    const domain = config.domainName;
    const mailFromDomain = `${config.mailFromSubdomain}.${domain}`;

    // ---------------------------------------------------------------- storage
    this.mailBucket = new s3.Bucket(this, 'MailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-raw-inbound',
          prefix: INBOUND_PREFIX,
          expiration: Duration.days(config.rawInboundRetentionDays),
        },
      ],
    });

    this.messagesTable = new dynamodb.TableV2(this, 'Messages', {
      partitionKey: { name: 'mailbox', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: MAILBOX_INDEX,
          partitionKey: { name: 'folderKey', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---------------------------------------------------------------- sending identity
    this.emailIdentity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(domain),
      dkimSigning: true,
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      mailFromDomain,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });

    // ---------------------------------------------------------------- receiving
    const inboundDlq = new sqs.Queue(this, 'InboundDeadLetters', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const inboundProcessor = backendFunction(this, 'InboundProcessor', {
      handler: 'inbound',
      description: 'Indexes messages received by SES into the mailbox table',
      timeout: Duration.seconds(60),
      memorySize: 1024,
      environment: {
        TABLE_NAME: this.messagesTable.tableName,
        BUCKET_NAME: this.mailBucket.bucketName,
        MAIL_DOMAIN: domain,
        INBOUND_PREFIX,
      },
    });
    // SES invokes the function asynchronously; events that still fail after the retries land in the queue.
    inboundProcessor.configureAsyncInvoke({
      retryAttempts: 2,
      onFailure: new destinations.SqsDestination(inboundDlq),
    });
    this.mailBucket.grantRead(inboundProcessor, `${INBOUND_PREFIX}*`);
    this.mailBucket.grantPut(inboundProcessor, 'mailboxes/*');
    this.messagesTable.grantWriteData(inboundProcessor);

    const ruleSet = new ses.ReceiptRuleSet(this, 'ReceiptRuleSet', {
      receiptRuleSetName: `${config.stackPrefix}-inbound`,
    });
    ruleSet.addRule('StoreAndIndex', {
      recipients: [domain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.OPTIONAL,
      actions: [
        new sesActions.S3({ bucket: this.mailBucket, objectKeyPrefix: INBOUND_PREFIX }),
        new sesActions.Lambda({ function: inboundProcessor, invocationType: sesActions.LambdaInvocationType.EVENT }),
      ],
    });

    if (config.activateReceiptRuleSet) {
      const activate = {
        service: 'SES',
        action: 'SetActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of(`${config.stackPrefix}-active-receipt-rule-set`),
      };
      new cr.AwsCustomResource(this, 'ActivateReceiptRuleSet', {
        onCreate: activate,
        onUpdate: activate,
        // Calling SetActiveReceiptRuleSet without a name deactivates the rule set so it can be deleted.
        onDelete: { service: 'SES', action: 'SetActiveReceiptRuleSet', parameters: {} },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ['ses:SetActiveReceiptRuleSet'], resources: ['*'] }),
        ]),
        installLatestAwsSdk: false,
      });
    }

    // ---------------------------------------------------------------- DNS
    const records = {
      inboundMx: { name: domain, type: 'MX', value: `10 inbound-smtp.${this.region}.amazonaws.com` },
      mailFromMx: { name: mailFromDomain, type: 'MX', value: `10 feedback-smtp.${this.region}.amazonses.com` },
      mailFromSpf: { name: mailFromDomain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
      apexSpf: { name: domain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
      dmarc: {
        name: `_dmarc.${domain}`,
        type: 'TXT',
        value: [
          'v=DMARC1',
          `p=${config.dmarc.policy}`,
          'adkim=r',
          'aspf=r',
          ...(config.dmarc.reportEmail ? [`rua=mailto:${config.dmarc.reportEmail}`] : []),
        ].join('; '),
      },
    };
    const dkim = [
      { name: this.emailIdentity.dkimDnsTokenName1, value: this.emailIdentity.dkimDnsTokenValue1 },
      { name: this.emailIdentity.dkimDnsTokenName2, value: this.emailIdentity.dkimDnsTokenValue2 },
      { name: this.emailIdentity.dkimDnsTokenName3, value: this.emailIdentity.dkimDnsTokenValue3 },
    ];

    // The records to create at the domain's DNS provider.
    dkim.forEach((token, i) => {
      new CfnOutput(this, `DnsDkim${i + 1}`, {
        description: `DKIM record ${i + 1} (CNAME)`,
        value: `${token.name} CNAME ${token.value}`,
      });
    });
    new CfnOutput(this, 'DnsInboundMx', { description: 'Receives mail for the domain', value: format(records.inboundMx) });
    new CfnOutput(this, 'DnsMailFromMx', { description: 'Custom MAIL FROM domain (bounces)', value: format(records.mailFromMx) });
    new CfnOutput(this, 'DnsMailFromSpf', { description: 'SPF for the MAIL FROM domain', value: format(records.mailFromSpf) });
    new CfnOutput(this, 'DnsApexSpf', { description: 'SPF for the domain itself', value: format(records.apexSpf) });
    new CfnOutput(this, 'DnsDmarc', { description: 'DMARC policy', value: format(records.dmarc) });
    new CfnOutput(this, 'MailBucketName', { value: this.mailBucket.bucketName });
    new CfnOutput(this, 'MessagesTableName', { value: this.messagesTable.tableName });
    new CfnOutput(this, 'InboundDeadLetterQueueUrl', { value: inboundDlq.queueUrl });
  }
}

function format(record: { name: string; type: string; value: string }): string {
  return record.type === 'TXT' ? `${record.name} TXT "${record.value}"` : `${record.name} ${record.type} ${record.value}`;
}
