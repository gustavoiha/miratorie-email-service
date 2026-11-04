import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface BackendFunctionProps {
  /** File name (without extension) under backend/src/handlers. */
  handler: string;
  description: string;
  environment: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
}

/** A Lambda function bundled with esbuild from the backend workspace. */
export function backendFunction(scope: Construct, id: string, props: BackendFunctionProps): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    description: props.description,
    entry: join(REPO_ROOT, 'backend', 'src', 'handlers', `${props.handler}.ts`),
    projectRoot: REPO_ROOT,
    depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize ?? 512,
    timeout: props.timeout ?? Duration.seconds(15),
    logGroup,
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
      ...props.environment,
    },
    bundling: {
      format: OutputFormat.CJS,
      target: 'node24',
      minify: true,
      sourceMap: true,
      // Bundle the AWS SDK too (rather than use the runtime's copy): the S3 presigners are not
      // guaranteed to be in the runtime, and must match the bundled S3 client version.
      externalModules: [],
    },
  });
}
