import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

function getPlaidEnv(): string {
  const env = process.env.PLAID_ENV || 'sandbox';
  switch (env) {
    case 'production': return PlaidEnvironments.production;
    case 'development': return PlaidEnvironments.development;
    default: return PlaidEnvironments.sandbox;
  }
}

let client: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (!client) {
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
      throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set');
    }

    const configuration = new Configuration({
      basePath: getPlaidEnv(),
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });

    client = new PlaidApi(configuration);
  }

  return client;
}

export function isPlaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}
