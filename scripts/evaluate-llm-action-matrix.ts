import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPABILITY_REGISTRY } from '../src/capabilities/capabilityRegistry';

type Mode = 'ollama_fast' | 'ollama_deep' | 'openai';
type Sample = { target: string; text: string };
type Result = { target: string; text: string; actual: string; ok: boolean; ms: number };
type LlmResponse = {
  error?: { message?: string };
  message?: { content?: string };
  choices?: Array<{ message?: { content?: string } }>;
};

const samples: Sample[] = [
  ['spotify.pause','mets la musique en pause'], ['spotify.play','reprends la musique'], ['spotify.next','passe au morceau suivant'], ['spotify.previous','reviens au morceau précédent'], ['spotify.now_playing','quel titre est en cours ?'], ['spotify.list_devices','liste mes appareils Spotify'], ['spotify.clear_queue','vide la file d’attente Spotify'], ['spotify.search','cherche Daft Punk sur Spotify'], ['spotify.search_and_play','joue Highway to Hell'], ['spotify.queue_add','ajoute Bohemian Rhapsody à la file'], ['spotify.transfer','transfère la musique sur le salon'], ['spotify.add_to_playlist','ajoute ce titre à ma playlist Rock'], ['spotify.volume_set','mets le volume Spotify à 30 %'], ['spotify.like_track','ajoute ce titre à mes favoris'],
  ['calendar.list_upcoming','quels sont mes prochains rendez-vous ?'], ['calendar.search_events','cherche mes rendez-vous avec Paul'], ['calendar.create_event','crée un rendez-vous dentiste mardi à 14 h'], ['calendar.delete_event','supprime mon rendez-vous dentiste'], ['calendar.update_event','décale mon rendez-vous dentiste à 15 h'], ['calendar.remove_from_event','retire Léa de la réunion de demain'],
  ['mail.send_email','envoie un e-mail à Léa pour confirmer le déjeuner'], ['mail.reply_email','réponds au dernier e-mail que je suis disponible'], ['mail.forward_email','transfère le dernier e-mail à Marc'], ['mail.trash_email','mets le dernier e-mail à la corbeille'], ['mail.mark_read','marque le dernier e-mail comme lu'], ['mail.mark_unread','marque le dernier e-mail comme non lu'], ['mail.flag_email','marque le dernier e-mail comme important'],
  ['todo.list_tasks','quelles tâches me restent-il aujourd’hui ?'], ['todo.list_lists','liste mes listes de tâches'], ['todo.add_task','ajoute acheter du lait à mes tâches'], ['todo.complete_task','marque acheter du lait comme terminée'], ['todo.delete_task','supprime la tâche acheter du lait'], ['todo.update_task','renomme la tâche acheter du lait en acheter du pain'], ['todo.create_list','crée une liste vacances'], ['todo.delete_list','supprime la liste vacances'], ['todo.add_checklist_item','ajoute passeport à la checklist vacances'], ['todo.complete_checklist_item','coche passeport dans la checklist vacances'], ['todo.delete_checklist_item','supprime passeport de la checklist vacances'],
  ['weather.current','quelle température fait-il chez moi ?'], ['search.query','cherche pourquoi le ciel est bleu'], ['executor.timer','mets un minuteur de cinq minutes'], ['nas_status.read','quel est l’état du NAS ?'],
].map(([target, text]) => ({ target, text }));

const catalog = CAPABILITY_REGISTRY.map((capability) => `${capability.agent}.${capability.action}`).join(', ');
function env() { return Object.fromEntries(readFileSync(resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).flatMap((line) => { const i = line.indexOf('='); return i > 0 ? [[line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]] : []; })); }

async function ask(mode: Mode, prompt: string) {
  const vars = env(); const native = mode === 'ollama_deep'; const started = performance.now();
  const url = native ? 'http://127.0.0.1:11434/api/chat' : mode === 'ollama_fast' ? 'http://127.0.0.1:11434/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const model = mode === 'ollama_fast' ? 'qwen3:4b-instruct' : native ? 'qwen3:8b' : (vars.OPENAI_MODEL ?? 'gpt-4o-mini');
  const body = native ? { model, messages: [{ role: 'user', content: prompt }], stream: false, think: false, options: { temperature: 0, num_predict: 30 } } : { model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 30 };
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: native || mode === 'ollama_fast' ? 'Bearer ollama' : `Bearer ${vars.OPENAI_API_KEY}` }, body: JSON.stringify(body) });
  const data = await response.json() as LlmResponse; if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
  return { content: (native ? data.message?.content : data.choices?.[0]?.message?.content)?.trim() ?? '', ms: Math.round(performance.now() - started) };
}

function extractTarget(content: string) { try { return String(JSON.parse(content).target ?? ''); } catch { return ''; } }
async function evaluate(mode: Mode) {
  await ask(mode, 'Réponds uniquement : prêt.');
  const results: Result[] = [];
  for (const sample of samples) {
    const prompt = `Tu es le routeur de Jarvis. Réponds uniquement par {"target":"agent.action"}, sans Markdown. Choisis exactement une valeur parmi : ${catalog}.\nDemande utilisateur : « ${sample.text} »`;
    try { const answer = await ask(mode, prompt); const actual = extractTarget(answer.content); results.push({ ...sample, actual, ok: actual === sample.target, ms: answer.ms }); }
    catch { results.push({ ...sample, actual: 'ERROR', ok: false, ms: 0 }); }
  }
  return results;
}

async function main() {
  if (samples.length !== CAPABILITY_REGISTRY.length) throw new Error(`Corpus incomplet: ${samples.length}/${CAPABILITY_REGISTRY.length}`);
  const startedAt = new Date().toISOString(); const results = Object.fromEntries(await Promise.all((['ollama_fast','ollama_deep','openai'] as Mode[]).map(async (mode) => [mode, await evaluate(mode)])));
  const report = { startedAt, scope: 'Classification de chacune des 42 actions de la capability registry. Aucun outil externe n’est exécuté.', models: { ollama_fast: 'qwen3:4b-instruct', ollama_deep: 'qwen3:8b native think:false', openai: env().OPENAI_MODEL ?? 'gpt-4o-mini' }, results };
  const file = resolve(process.cwd(), 'artifacts', `llm-action-matrix-${startedAt.replace(/[:.]/g, '-')}.json`); writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  for (const [mode, entries] of Object.entries(results) as Array<[Mode, Result[]]>) { const ok = entries.filter((entry) => entry.ok).length; console.log(`${mode}: ${ok}/${entries.length} (${Math.round(ok / entries.length * 100)} %), ${Math.round(entries.reduce((sum, entry) => sum + entry.ms, 0) / entries.length)} ms/action`); for (const entry of entries.filter((item) => !item.ok)) console.log(`  ${entry.target} -> ${entry.actual}`); }
  console.log(`Rapport: ${file}`);
}
void main();
