export interface AppConfig {
  region: string;
  mailDomain: string;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  hostedUiUrl: string;
}

/** The runtime configuration is written next to the app by the CDK deployment. */
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Could not load /config.json. For local development run `npm run config:local -w frontend`.');
  }
  return (await response.json()) as AppConfig;
}
