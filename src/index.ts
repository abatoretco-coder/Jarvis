import { loadEnv } from './env';
import { buildApp } from './server';

async function main() {
  const env = loadEnv();
  const app = buildApp(env);
  await app.listen({ port: env.PORT, host: env.BIND_HOST });
}

main().catch((err) => {
  const asText = (() => {
    if (err instanceof Error) {
      const base = `${err.name}: ${err.message}`;
      return err.stack ? `${base}\n${err.stack}` : base;
    }
    return String(err);
  })();

  const redacted = asText
    .replace(/(Bearer\s+)[A-Za-z0-9._~\-+/]+=*/g, '$1[REDACTED]')
    .replace(/("access_token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/("refresh_token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/(HA_TOKEN=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(HA_LONG_LIVED_TOKEN=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(OPENAI_API_KEY=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(SPOTIFY_WEBAPI_CLIENT_SECRET=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(SPOTIFY_WEBAPI_REFRESH_TOKEN=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(SPOTIFY_PASSWORD=)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(X-API-Key\s*:\s*)([^\s,]+)/gi, '$1[REDACTED]');

  // eslint-disable-next-line no-console
  console.error(redacted);
  process.exit(1);
});
