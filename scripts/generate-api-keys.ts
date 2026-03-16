/// <reference types="node" />

import { randomBytes } from 'crypto';

type Options = {
  count: number;
  bytes: number;
  withEnvLine: boolean;
};

function parseArgs(argv: string[]): Options {
  let count = 3;
  let bytes = 48;
  let withEnvLine = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count' && argv[i + 1]) {
      count = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--bytes' && argv[i + 1]) {
      bytes = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--no-env-line') {
      withEnvLine = false;
    }
  }

  if (!Number.isFinite(count) || count < 1 || count > 50) {
    throw new Error('Invalid --count (expected 1..50)');
  }

  if (!Number.isFinite(bytes) || bytes < 16 || bytes > 256) {
    throw new Error('Invalid --bytes (expected 16..256)');
  }

  return { count: Math.trunc(count), bytes: Math.trunc(bytes), withEnvLine };
}

function generateToken(bytes: number): string {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const tokens = Array.from({ length: options.count }, () => generateToken(options.bytes));

  tokens.forEach((token, index) => {
    const label = index === 0 ? 'MOBILE' : index === 1 ? 'DESKTOP' : index === 2 ? 'ADMIN' : `CLIENT_${index + 1}`;
    process.stdout.write(`${label}_TOKEN=${token}\n`);
  });

  if (options.withEnvLine) {
    process.stdout.write(`API_KEYS=${tokens.join(',')}\n`);
  }
}

main();
