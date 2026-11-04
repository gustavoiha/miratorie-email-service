import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { PRIMARY_EMAIL_ATTRIBUTE } from './auth-stack.js';
import { backendFunction } from './backend-function.js';
import type { EmailServiceConfig } from './config.js';
import { MAILBOX_INDEX } from './mail-stack.js';
import { securityHeaders, securityHeadersFunctionCode } from './security-headers.js';

export interface AppStackProps extends StackProps {
  config: EmailServiceConfig;
  mailBucket: s3.IBucket;
  messagesTable: dynamodb.ITableV2;
  userPool: cognito.IUserPool;
  userPoolDomain: cognito.UserPoolDomain;
  /** Directory holding the built frontend (frontend/dist). */
  frontendDistPath: string;
}

/** The web application: static frontend on CloudFront, the Cognito app client and the HTTP API. */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, mailBucket, messagesTable, userPool, userPoolDomain } = props;

    // ---------------------------------------------------------------- hosting
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const hostedUiUrl = userPoolDomain.baseUrl();
    const web = config.web;

    // Attachments on their way in (browser uploads) and out (downloads), kept for a day at most.
    const transferBucket = new s3.Bucket(this, 'TransferBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'expire-transfers', expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });

    // ---------------------------------------------------------------- security headers
    const securityHeadersFunction = new cloudfront.Function(this, 'SecurityHeadersFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        securityHeadersFunctionCode(
          securityHeaders({
            // Without a custom domain, a wildcard avoids a dependency cycle: the API's CORS config needs the distribution URL.
            apiOrigin: config.api ? `https://${config.api.domainName}` : `https://*.execute-api.${this.region}.amazonaws.com`,
            hostedUiUrl,
            // Same reason: the bucket's CORS rule needs the distribution URL when there is no custom domain.
            uploadOrigin: web ? `https://${transferBucket.bucketName}.s3.${this.region}.amazonaws.com` : `https://*.s3.${this.region}.amazonaws.com`,
          }),
        ),
      ),
    });

    const certificate = web
      ? acm.Certificate.fromCertificateArn(
          this,
          'WebCertificate',
          ssm.StringParameter.valueForStringParameter(this, web.certificateArnParameter),
        )
      : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.domainName} webmail`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [{ function: securityHeadersFunction, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE }],
      },
      domainNames: web ? [web.domainName] : undefined,
      certificate,
      // A distribution on a CloudFront pricing plan must keep its web ACL: without it the deploy tries to remove it.
      webAclId: config.webAclArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Single-page app: unknown paths load the app instead of S3's 403.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
      ],
    });
    const webUrl = `https://${web ? web.domainName : distribution.distributionDomainName}`;
    const appOrigins = [webUrl, ...config.localDevOrigins];
    // The browser posts attachment uploads straight to the bucket (presigned POST); downloads are plain navigations.
    transferBucket.addCorsRule({
      allowedOrigins: appOrigins,
      allowedMethods: [s3.HttpMethods.POST],
      allowedHeaders: ['*'],
      maxAge: 3600,
    });

    // ---------------------------------------------------------------- auth client
    const userPoolClient = new cognito.UserPoolClient(this, 'WebClient', {
      userPool,
      userPoolClientName: `${config.stackPrefix}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE, cognito.OAuthScope.PHONE],
        callbackUrls: appOrigins.map((origin) => `${origin}/`),
        logoutUrls: appOrigins.map((origin) => `${origin}/`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ fullname: true, email: true, emailVerified: true, phoneNumber: true, phoneNumberVerified: true })
        .withCustomAttributes(PRIMARY_EMAIL_ATTRIBUTE),
      // Users must not be able to change their own mailbox address.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true, email: true, phoneNumber: true }),
    });

    // ---------------------------------------------------------------- API
    const apiFunction = backendFunction(this, 'ApiFunction', {
      handler: 'api',
      description: 'Mailbox API: list, read, send and organise messages',
      // Just under the 30 s limit of API Gateway: sending reads, builds and sends up to ~35 MB.
      timeout: Duration.seconds(29),
      memorySize: 1536,
      environment: {
        TABLE_NAME: messagesTable.tableName,
        TABLE_INDEX: MAILBOX_INDEX,
        BUCKET_NAME: mailBucket.bucketName,
        TRANSFER_BUCKET_NAME: transferBucket.bucketName,
        MAIL_DOMAIN: config.domainName,
        ACCESS_GROUP: config.accessGroupName,
      },
    });
    messagesTable.grantReadWriteData(apiFunction);
    mailBucket.grantReadWrite(apiFunction, 'mailboxes/*');
    mailBucket.grantDelete(apiFunction, 'mailboxes/*');
    transferBucket.grantReadWrite(apiFunction);
    transferBucket.grantDelete(apiFunction, 'uploads/*');
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        // While SES is in the sandbox, sending also needs permission on the (verified) recipient identities.
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
      }),
    );

    // HTTP API custom domains are regional: the certificate must be in the deployment region, not us-east-1.
    const apiDomain = config.api
      ? new apigw.DomainName(this, 'ApiDomain', {
          domainName: config.api.domainName,
          certificate: acm.Certificate.fromCertificateArn(
            this,
            'ApiCertificate',
            ssm.StringParameter.valueForStringParameter(this, config.api.certificateArnParameter),
          ),
        })
      : undefined;

    const api = new apigw.HttpApi(this, 'Api', {
      apiName: `${config.stackPrefix}-api`,
      createDefaultStage: false,
      // With a custom domain, the API is only reachable there.
      disableExecuteApiEndpoint: Boolean(apiDomain),
      corsPreflight: {
        allowOrigins: appOrigins,
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(1),
      },
    });
    api.addStage('DefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      domainMapping: apiDomain ? { domainName: apiDomain } : undefined,
    });

    // Validates the Cognito ID token; group membership is checked in the function.
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);
    const routes: Array<[string, apigw.HttpMethod]> = [
      ['/me', apigw.HttpMethod.GET],
      ['/messages', apigw.HttpMethod.GET],
      ['/messages', apigw.HttpMethod.POST],
      ['/messages/{id}', apigw.HttpMethod.GET],
      ['/messages/{id}', apigw.HttpMethod.PATCH],
      ['/messages/{id}', apigw.HttpMethod.DELETE],
      ['/messages/{id}/attachments/{index}', apigw.HttpMethod.GET],
      ['/attachments', apigw.HttpMethod.POST],
    ];
    for (const [path, method] of routes) {
      api.addRoutes({ path, methods: [method], integration, authorizer });
    }
    const apiUrl = config.api ? `https://${config.api.domainName}` : api.apiEndpoint;

    // ---------------------------------------------------------------- frontend deployment
    const frontendConfig = {
      region: this.region,
      mailDomain: config.domainName,
      apiUrl,
      userPoolId: userPool.userPoolId,
      userPoolClientId: userPoolClient.userPoolClientId,
      hostedUiUrl,
    };

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(props.frontendDistPath), s3deploy.Source.jsonData('config.json', frontendConfig)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      // As on the landing page: browsers may keep index.html for 5 minutes, so the hashed bundles it names are
      // not pruned on deploy; otherwise a cached index.html would point at deleted files.
      prune: false,
      cacheControl: [s3deploy.CacheControl.setPublic(), s3deploy.CacheControl.maxAge(Duration.minutes(5))],
      memoryLimit: 512,
    });

    new CfnOutput(this, 'WebUrl', { value: webUrl });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: web ? `Target of the DNS-only CNAME record for ${web.domainName}` : 'CloudFront domain of the web client',
    });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    if (apiDomain) {
      new CfnOutput(this, 'ApiDomainTarget', {
        value: apiDomain.regionalDomainName,
        description: `Target of the DNS-only CNAME record for ${config.api!.domainName}`,
      });
    }
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'FrontendConfig', {
      description: 'Runtime configuration of the web app (used by `npm run config:local -w frontend`)',
      value: Stack.of(this).toJsonString(frontendConfig),
    });
  }
}
