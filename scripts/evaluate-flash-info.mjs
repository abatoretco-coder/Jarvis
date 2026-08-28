/** Product-level check for the exact Flash Info route used by Jarvis Desktop. */
const baseUrl = (process.env.JARVIS_SELF_URL || 'http://127.0.0.1:8090').replace(/\/$/u, '');
const apiKey = (process.env.API_KEYS || process.env.API_KEY || '').split(',')[0].trim();
const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
const promotional = /\b(blink|amazon|promo(?:tion)?|sonnette|code promo|bon plan)\b/iu;

const itemsResponse = await fetch(`${baseUrl}/v1/news/items?geoFilter=world&tab=world&sectors=general`, { headers });
if (!itemsResponse.ok) throw new Error(`items_http_${itemsResponse.status}`);
const itemsPayload = await itemsResponse.json();
const items = itemsPayload.items || [];
if (items.length < 2) throw new Error(`insufficient_enriched_evidence:${items.length}`);
if (items.some((item) => promotional.test(`${item.title} ${item.snippet} ${item.source}`))) {
  throw new Error('promotional_item_leaked');
}
if (items.some((item) => (item.snippet || '').length < 90)) throw new Error('non_enriched_item_leaked');
if (items.some((item) => /\b(the|and|with|that|this|from|into|teachers)\b/iu.test(item.snippet || ''))) {
  throw new Error('untranslated_summary_leaked');
}

const summaryResponse = await fetch(`${baseUrl}/v1/news/summary`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    scopeLabel: 'Évaluation qualité Flash Info',
    contextFacts: [`${items.length} articles enrichis et vérifiables`],
    outputStyle: { neutralOnly: true, oneIdeaPerBullet: true },
    items: items.slice(0, 6),
  }),
});
if (!summaryResponse.ok) throw new Error(`summary_http_${summaryResponse.status}`);
const summaryPayload = await summaryResponse.json();
const text = String(summaryPayload.text || '');
if (!text.includes('## Ce qui compte') || !text.includes('## Ce que cela implique')) throw new Error('summary_missing_product_structure');
if (text.includes('## Faits distincts')) throw new Error('summary_unexpected_heading');
if (promotional.test(text)) throw new Error('promotional_summary_leaked');
const summaryBullets = text.split(/\r?\n/u).filter((line) => line.startsWith('- '));
if (summaryBullets.length < 3) throw new Error('summary_insufficient_facts');
if (summaryBullets.some((line) => !/\([^()]{2,80}\)/u.test(line))) throw new Error('summary_unattributed_fact');
if (summaryBullets.some((line) => !/[.!?][^.!?]*\)?$/u.test(line))) throw new Error('summary_incomplete_fact');

console.log(JSON.stringify({
  ok: true,
  enrichedEvidence: items.length,
  sources: [...new Set(items.map((item) => item.source))],
  freshness: itemsPayload.freshness,
  summaryCharacters: text.length,
}, null, 2));
