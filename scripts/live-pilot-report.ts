import Database from 'better-sqlite3';

import { buildLivePilotReport } from '../src/voice/live/LivePilotReport';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = option('database');
if (!databasePath) throw new Error('missing_required_option:--database');
const sinceRaw = option('since');
const sinceMs = sinceRaw ? Date.parse(sinceRaw) : 0;
if (!Number.isFinite(sinceMs)) throw new Error('invalid_option:--since');

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  console.log(JSON.stringify(buildLivePilotReport(db, sinceMs), null, 2));
} finally {
  db.close();
}
