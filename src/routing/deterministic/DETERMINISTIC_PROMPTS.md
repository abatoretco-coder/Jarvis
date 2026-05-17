# Deterministic Prompts & Responses

**Statut**: Phase 0  
**Dernière mise à jour**: Mai 2026

---

## 📋 Vue d'ensemble

Ce dossier contient les **réponses déterministes** pour toutes les actions E2 du Semantic Router.

**Principe** : 
- Les actions E2 ne passent **PAS** par une IA pour générer les réponses
- À la place, on utilise des phrases pré-écrites, variées, TTS-friendly
- Cela garantit : ultra-rapide, déterministe, prévisible

---

## 🏗️ Structure

```
deterministic/
├── spotifyResponses.ts        ← Responses Spotify (COMPLET Phase 0)
├── searchResponses.ts         ← Responses Search (STUBS)
├── todoResponses.ts           ← Responses Todo (STUBS)
├── mailResponses.ts           ← Responses Mail (STUBS)
├── haResponses.ts             ← Responses HA (TODO Phase 3)
├── DETERMINISTIC_PROMPTS.md   ← Ce fichier
└── types.ts                   ← Types partagés (TODO)
```

---

## 📝 Fichier par domaine

### spotifyResponses.ts (COMPLET)

Format :
```ts
export const SPOTIFY_PAUSE_RESPONSES = [
  'Musique en pause.',
  'J\'ai mis en pause.',
  'Pause.',
  'C\'est en pause.',
];
```

**Patterns** :
- **Variantes simples** : 3-4 phrasings du même contenu
- **Templates** : pour données dynamiques (artist, track, volume)
  ```ts
  export const SPOTIFY_NOW_PLAYING_TEMPLATE = (artist: string, track: string): string => {
    return `Actuellement : ${track} de ${artist}.`;
  };
  ```
- **Helper générique** : `getSpotifyResponse(action, params)` retourne une variante aléatoire

**Actions implémentées** :
- `pause` (4 variantes)
- `play` (4 variantes)
- `next` (4 variantes)
- `previous` (4 variantes)
- `now_playing` (template + fallback)
- `list_devices` (template + fallback)
- `clear_queue` (3 variantes)

### searchResponses.ts (STUBS Phase 0 → à remplir Phase 1)

**Format stub** :
```ts
export const SEARCH_WEATHER_RESPONSES = ['Je n\'arrive pas à dire la météo pour le moment.'];
```

À remplir pour Phase 1 :
- `search.news.weather` → résumé météo court
- `search.news.live_sport` → résultats sportifs
- `search.news.current_news` → actus du jour
- `search.web.definition` → définition rapide
- `search.web.quick_lookup` → lookup factuel

### todoResponses.ts (STUBS Phase 0 → intégré avec LLM synthesis)

**Approche spéciale** :
- Les réponses Todo utilisent **LLM synthesis** (voir [todoAgent.ts](../../todo/todoAgent.ts))
- Les stubs déterministes ici sont des **fallbacks** si OpenAI échoue
- Pas de templates dynamiques ici (géré par synthesis)

À remplir pour Phase 1 :
- `list_tasks` (génériques)
- `list_tasks.today/tomorrow/this_week/overdue` (génériques)
- `list_lists` (génériques)

### mailResponses.ts (STUBS Phase 0 → intégré avec LLM synthesis)

**Approche spéciale** (idem Todo) :
- Réponses Mail utilisent **LLM synthesis** (voir [mailAgent.ts](../../mail/mailAgent.ts))
- Stubs ici = **fallbacks** si OpenAI échoue
- Pattern : `firstSentence()` récupère première phrase du résultat executor

À remplir pour Phase 1 :
- `list_inbox` (génériques)
- `list_inbox.unread` (génériques)

### haResponses.ts (TODO Phase 3)

À créer en Phase 3 pour Home Assistant executors simples.

---

## 🎯 Patterns & conventions

### 1. Variantes simples

Pour une action, 3-4 phrasings différents :

```ts
export const SPOTIFY_PAUSE_RESPONSES = [
  'Musique en pause.',        // Formel
  'J\'ai mis en pause.',      // Action réalisée
  'Pause.',                   // Minimaliste
  'C\'est en pause.',         // Confirmação
];
```

**Critères** :
- Court (max 10 mots)
- Oral-friendly (pas "musique mise en pause", mais "musique en pause")
- Affirmation (pas interrogation)
- TTS-friendly (pas de caractères bizarres)

### 2. Templates pour données dynamiques

Si besoin d'injecter du contenu (artist, device, task name) :

```ts
export const SPOTIFY_NOW_PLAYING_TEMPLATE = (artist: string, track: string): string => {
  const variants = [
    `Actuellement : ${track} de ${artist}.`,
    `Ça joue : ${track} par ${artist}.`,
    `${track} de ${artist}.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
};
```

**Critères** :
- Chaque template = max 1-2 slots
- Sanitizer inputs (échapper les guillemets)
- Max 15 mots avec slots remplis

### 3. Helpers génériques

```ts
export function getSpotifyResponse(action: string, params?: Record<string, any>): string {
  switch (action) {
    case 'pause':
      return SPOTIFY_PAUSE_RESPONSES[Math.floor(Math.random() * SPOTIFY_PAUSE_RESPONSES.length)];
    // ...
    case 'now_playing':
      if (params?.artist && params?.track) {
        return SPOTIFY_NOW_PLAYING_TEMPLATE(params.artist, params.track);
      }
      return SPOTIFY_NOW_PLAYING_RESPONSES[0];
    default:
      return 'Action effectuée.';
  }
}
```

---

## 🔌 Intégration dans semanticRouteCatalog.ts

Chaque route E2 pointe vers sa fonction de réponses :

```ts
{
  key: 'spotify.pause',
  level: 'E2',
  // ...
  deterministicResponses: () => SPOTIFY_PAUSE_RESPONSES,
}
```

Lors de l'exécution directe (E2) :

```ts
// src/routing/routeDispatcher.ts (Phase 2+)
const response = route.deterministicResponses?.() ?? [];
const randomReply = response[Math.floor(Math.random() * response.length)];
return randomReply || 'Action effectuée.';
```

---

## 🌐 Localisation

Toutes les réponses sont en **français** (locale HA par défaut).

À l'avenir (Phase 4+) :

```ts
export const SPOTIFY_PAUSE_RESPONSES_FR = [...];
export const SPOTIFY_PAUSE_RESPONSES_EN = [...];
export const SPOTIFY_PAUSE_RESPONSES_ES = [...];

export function getSpotifyResponse(action: string, locale: 'fr' | 'en' | 'es' = 'fr', params?: Record<string, any>): string {
  // ...
}
```

---

## ✅ Checklist de qualité

Avant de soumettre une réponse :

- [ ] 3-4 variantes minimum
- [ ] Toutes les variantes <= 10 mots
- [ ] Aucune interrogation (affirmations seulement)
- [ ] Pas de caractères spéciaux (sauf apostrophe, tiret)
- [ ] TTS-friendly (accent français naturel)
- [ ] Pas d'emojis
- [ ] Template (si applicable) a max 1-2 slots
- [ ] Helper générique retourne valeur par défaut sensée
- [ ] Colle bien avec le contexte de l'action (pause → confirmation pause)

---

## 📈 Évolutions futures

### Phase 1
- Remplir searchResponses + todoResponses + mailResponses

### Phase 2
- Ajouter E1 responses (pas direct, mais pour logging/monitoring)

### Phase 3
- HA executors responses
- Adaptive responses selon contexte (user preferences)

### Phase 4
- Multi-language support
- User-customizable responses
- A/B testing (quelles variantes sont les plus naturelles ?)

---

## 🔍 Debugging

Pour tester une réponse localement :

```bash
cd Jarvis
npm run build

# Dans un test ou endpoint /debug:
import { getSpotifyResponse } from './src/routing/deterministic/spotifyResponses';

console.log(getSpotifyResponse('pause'));           // Random varante
console.log(getSpotifyResponse('now_playing', {artist: 'Daft Punk', track: 'One More Time'}));
```

---

**Status** : Phase 0 (Spotify COMPLET, autres STUBS)  
**Prochaine étape** : Phase 1 — Remplir tous les stubs
