import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { EmailServiceConfig } from './config.js';

/** Name of the custom attribute holding the user's mailbox address (without the "custom:" prefix). */
export const PRIMARY_EMAIL_ATTRIBUTE = 'primary_email';

export interface AuthStackProps extends StackProps {
  config: EmailServiceConfig;
}

/**
 * Cognito user pool for the mail users. There is no self sign-up: the operator creates users
 * by hand and adds them to the access group.
 *
 * Attribute mapping:
 *  - `custom:primary_email` is the mailbox address on the service domain (alice@example.com).
 *  - `email` is the *secondary* address (e.g. a Gmail address). Cognito sends invitations,
 *    verification and password-reset codes there, so it works even if the mailbox is unreachable.
 *  - `name` and `phone_number` are required profile attributes.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolDomain: cognito.UserPoolDomain;
  readonly accessGroupName: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `${config.stackPrefix}-users`,
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      signInCaseSensitive: false,
      standardAttributes: {
        fullname: { required: true, mutable: true },
        email: { required: true, mutable: true },
        phoneNumber: { required: true, mutable: true },
      },
      customAttributes: {
        [PRIMARY_EMAIL_ATTRIBUTE]: new cognito.StringAttribute({ minLen: 3, maxLen: 254, mutable: true }),
      },
      autoVerify: { email: true },
      keepOriginal: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: cognito.Mfa.OFF,
      userInvitation: {
        emailSubject: `Your ${config.domainName} mailbox is ready`,
        emailBody:
          `Hello,<br><br>A mailbox on ${config.domainName} has been created for you.<br>` +
          'Username: <b>{username}</b><br>Temporary password: <b>{####}</b><br><br>' +
          'You will be asked to choose a new password when you first sign in.',
      },
      userVerification: {
        emailSubject: `Verify your recovery email for ${config.domainName}`,
        emailBody: 'Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.accessGroupName = config.accessGroupName;
    new cognito.UserPoolGroup(this, 'AccessGroup', {
      userPool: this.userPool,
      groupName: config.accessGroupName,
      description: `Members can use the ${config.domainName} email service`,
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'AccessGroupName', { value: config.accessGroupName });
    new CfnOutput(this, 'HostedUiUrl', { value: this.userPoolDomain.baseUrl() });
  }
}
