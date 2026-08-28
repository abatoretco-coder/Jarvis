#!/bin/sh
set -eu

mkdir -p /app/data
chown -R node:node /app/data
chmod 700 /app/data
find /app/data -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.sqlite' -o -name '*.sqlite-shm' -o -name '*.sqlite-wal' \) \
  -exec chmod 600 {} +

umask 077

# The Ollama health endpoint only proves that the daemon is up; it does not
# load the router model.  Starting Jarvis before that load completes makes the
# first real conversation occupy the sole Ollama slot and hit ROUTER_TIMEOUT_MS.
# Warm it before exposing the API, with a bounded retry so a temporarily absent
# local runtime cannot keep the service down forever.
if [ "${LLM_PROVIDER:-}" = "ollama" ] || [ "${LLM_PROVIDER:-}" = "hybrid" ]; then
  node - <<'NODE'
const baseUrl = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const model = (process.env.OLLAMA_MODEL || '').trim();
if (!baseUrl || !model) process.exit(0);

const deadline = Date.now() + 90000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function warm() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 1,
          think: false,
          messages: [{ role: 'user', content: 'OK' }],
        }),
      });
      if (response.ok) {
        console.log(`jarvis_local_llm_warmup_ready model=${model}`);
        return;
      }
      console.warn(`jarvis_local_llm_warmup_http_${response.status}`);
    } catch (error) {
      console.warn(`jarvis_local_llm_warmup_retry ${String(error)}`);
    }
    await wait(1000);
  }
  console.warn(`jarvis_local_llm_warmup_timed_out model=${model}; starting anyway`);
}

warm().catch((error) => {
  console.warn(`jarvis_local_llm_warmup_unexpected ${String(error)}`);
});
NODE
fi

exec su-exec node "$@"
