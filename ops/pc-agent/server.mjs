/* global AbortSignal, fetch, process, setTimeout */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.JARVIS_PC_AGENT_BASE_URL ?? '').replace(/\/$/u, '');
const apiKey = process.env.JARVIS_PC_AGENT_API_KEY ?? '';

if (!/^https:\/\//u.test(baseUrl) || apiKey.length < 32) throw new Error('pc_agent_configuration_invalid');

async function spotifyRunning() {
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq Spotify.exe', '/NH'], {
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    });
    return /Spotify\.exe/iu.test(stdout);
  } catch {
    return false;
  }
}

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`pc_agent_http_${response.status}`);
  return response.json();
}

function openSpotify() {
  const child = spawn(`${process.env.WINDIR ?? 'C:\\Windows'}\\explorer.exe`, ['spotify:'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

while (!stopped) {
  try {
    const status = await request('/v1/pc-agent/poll', { spotifyRunning: await spotifyRunning() });
    const command = status?.command;
    if (command?.type === 'open_spotify' && typeof command.id === 'string') {
      let success = true;
      try { openSpotify(); } catch { success = false; }
      await request('/v1/pc-agent/commands/complete', { commandId: command.id, success });
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'pc_agent_poll_failed';
    process.stderr.write(`${new Date().toISOString()} ${code}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
