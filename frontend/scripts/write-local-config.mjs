// Writes frontend/public/config.json from the stack outputs saved by `npm run deploy`
// (infra/cdk-outputs.json), so `npm run dev` can talk to the deployed backend.
import { readFileSync, writeFileSync } from 'node:fs';

const outputsUrl = new URL('../../infra/cdk-outputs.json', import.meta.url);
const targetUrl = new URL('../public/config.json', import.meta.url);

let outputs;
try {
  outputs = JSON.parse(readFileSync(outputsUrl, 'utf8'));
} catch {
  console.error('infra/cdk-outputs.json not found. Deploy first with `npm run deploy` from the repository root.');
  process.exit(1);
}

const appStack = Object.entries(outputs).find(([, values]) => values.FrontendConfig);
if (!appStack) {
  console.error('No FrontendConfig output found in infra/cdk-outputs.json.');
  process.exit(1);
}

writeFileSync(targetUrl, `${JSON.stringify(JSON.parse(appStack[1].FrontendConfig), null, 2)}\n`);
console.log(`Wrote frontend/public/config.json from ${appStack[0]}.`);
