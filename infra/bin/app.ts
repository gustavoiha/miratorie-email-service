import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, Tags } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { REPO_ROOT } from '../lib/backend-function.js';
import { loadConfig } from '../lib/config.js';
import { MailStack } from '../lib/mail-stack.js';

const infraDir = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig(infraDir);

const frontendDistPath = join(REPO_ROOT, 'frontend', 'dist');
if (!existsSync(join(frontendDistPath, 'index.html'))) {
  throw new Error('frontend/dist is missing. Run `npm run build` at the repository root before synthesizing.');
}

const app = new App();
const env = { account: config.account, region: config.region };

const mail = new MailStack(app, `${config.stackPrefix}-Mail`, {
  env,
  config,
  description: `SES identity, receiving rules and mail storage for ${config.domainName}`,
});

const auth = new AuthStack(app, `${config.stackPrefix}-Auth`, {
  env,
  config,
  description: `Cognito user pool for ${config.domainName} mail users`,
});

new AppStack(app, `${config.stackPrefix}-App`, {
  env,
  config,
  description: `Webmail frontend and API for ${config.domainName}`,
  mailBucket: mail.mailBucket,
  messagesTable: mail.messagesTable,
  userPool: auth.userPool,
  userPoolDomain: auth.userPoolDomain,
  frontendDistPath,
});

Tags.of(app).add('app', 'miratorie-email-service');
Tags.of(app).add('mail-domain', config.domainName);
