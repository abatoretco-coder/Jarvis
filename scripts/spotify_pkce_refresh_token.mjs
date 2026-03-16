#!/usr/bin/env node
// Minimal Spotify OAuth PKCE helper to obtain a refresh_token.
// No client secret required.
// Usage:
//   node scripts/spotify_pkce_refresh_token.mjs --client-id <id> --redirect-uri http://127.0.0.1:8899/callback
// Then open the printed URL, accept, and the script will print REFRESH_TOKEN.

import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256base64url(input) {
  const hash = crypto.createHash('sha256').update(input).digest();
  return base64url(hash);
}

async function postForm(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, json };
}

const args = parseArgs(process.argv);
const clientId = String(args['client-id'] || '').trim();
if (!clientId) {
  console.error('Missing --client-id');
  process.exit(2);
}

const redirectUri = String(args['redirect-uri'] || 'http://127.0.0.1:8899/callback').trim();
const scopes = String(
  args.scope ||
    'user-read-playback-state user-modify-playback-state'
).trim();

const redirect = new URL(redirectUri);
const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));

const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = sha256base64url(codeVerifier);

const state = base64url(crypto.randomBytes(16));

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('scope', scopes);

console.log('Open this URL in a browser and approve:');
console.log(authUrl.toString());
console.log('');

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', redirectUri);
    if (u.pathname !== redirect.pathname) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const gotState = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');

    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Spotify error: ' + err);
      console.error('Spotify returned error:', err);
      process.exit(1);
    }

    if (!code || gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid callback (missing code or bad state).');
      console.error('Invalid callback. code=', Boolean(code), 'state_ok=', gotState === state);
      process.exit(1);
    }

    const tokenResp = await postForm('https://accounts.spotify.com/api/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    if (!tokenResp.ok) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Token exchange failed. Check console.');
      console.error('Token exchange failed:', tokenResp.status, tokenResp.json);
      process.exit(1);
    }

    const refreshToken = tokenResp.json.refresh_token;
    if (!refreshToken) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('No refresh_token returned.');
      console.error('No refresh_token in response:', tokenResp.json);
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK. You can close this tab and go back to the terminal.');

    console.log('REFRESH_TOKEN=' + refreshToken);
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
    console.error(e);
    process.exit(1);
  }
});

server.listen(port, redirect.hostname, () => {
  console.log(`Listening on ${redirect.hostname}:${port}${redirect.pathname}`);
});
