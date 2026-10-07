# Inventaire des worktrees avant refonte

Date de référence : 2026-10-06.

Cet inventaire sépare explicitement les travaux déjà présents de la refonte Jarvis Platform. Aucun des changements listés ci-dessous ne doit être écrasé, nettoyé ou absorbé implicitement par la migration IA/identité.

## Révisions de référence

| Dépôt | Branche | Commit de départ | État initial |
| --- | --- | --- | --- |
| Jarvis | `main` | `2d1cd3c41dac11070ad8876e3b96d6fc0fd8c2d6` | plan du domicile non suivi |
| Jarvis Desktop | `main` | `ddc8be7c8274ad5f2f66b551e951e65712e3490e` | travail OpenWakeWord en cours |
| Jarvis APK | `main` | `714c0a535a44439fb2adb44b20a213e44de32215` | propre |
| Home assistant | `main` | `9b9113a8d70989608ebeff1a4f4b45010960a2d4` | réglage Kokoro en cours |
| Agora | `main` | `56c8418a1cdf670c617f7e42815a7dccbd9779bd` | propre |

## Lot existant A — OpenWakeWord Desktop

Fichiers modifiés ou ajoutés avant la refonte :

- `src-tauri/binaries/openwakeword-sidecar-x86_64-pc-windows-msvc.exe`
- `src-tauri/sidecar/openwakeword_sidecar.py`
- `src/App.tsx`
- `src/components/SettingsView.tsx`
- `src/hooks/useAudio.ts`
- `src/utils/wakeThreshold.ts`
- `src/utils/wakeThreshold.test.ts`

Le lot augmente le nombre de trames positives du sidecar, relève le seuil minimal réglable et exige une confirmation STT avant d'armer la fenêtre de commande. Il appartient au chantier wake word conservé en local et doit être intégré séparément de la migration OpenAI.

Empreintes SHA-256 initiales :

| Fichier | SHA-256 |
| --- | --- |
| binaire sidecar | `BCCB208B14031806DFCC3B9595E0A6911095CE031F9BBE02C3648E9B3727BD2D` |
| sidecar Python | `2A05F140D73908EDFFD438268D949BF065650301C1CA97469781257DF2AA6CD5` |
| `App.tsx` | `AC02A7F16AC70A69927DC27FB99691124B48C4C830E540277DE8BF5B30EB858E` |
| `SettingsView.tsx` | `867DD70FF4CD7A977E744AFF6BBFC32DE37E89B176A67E85E0D4FDA7999B8601` |
| `useAudio.ts` | `39F80CDE1F992BE53459F5DFF8621C85407458D92F2848A9C2865B3349D14F02` |
| `wakeThreshold.ts` | `97C81B4B0167D1F94C16DFDA30E768AB9BD12051E662039190ABD4CE1D094140` |
| `wakeThreshold.test.ts` | `1021E0289E1B83881CBF24DC09E284F9A40F4B26FC6E1FCB9F4F665EFCDE0D61` |

## Lot existant B — Voix Kokoro Home Assistant

`docker-compose.dev.yml` sélectionne la voix française `ff_siwis` à la place de `am_michael`.

Empreinte SHA-256 initiale : `3FD996F8853DD735A93EAFB69ADA8EC810372388E60DE57A8B12DE1231CCF7AE`.

Ce changement est conservé comme état historique, mais deviendra obsolète lorsque Kokoro sera retiré au chantier 1E. Il ne doit pas être mélangé à la première bascule OpenAI.

## Lot existant C — Modèle du domicile

Le dossier `config/homes/home_fr_paris_10_fsm_236_lot_204/` et le générateur `scripts/generate-home-plan-assets.mjs` forment un seul lot fonctionnel : modèle canonique, SVG 2D et OBJ 3D. Ce lot prépare le chantier 7 et reste indépendant des chantiers IA et identité.

## Changements appartenant à la baseline

- Déclaration des globals Node dans `scripts/generate-home-plan-assets.mjs`, nécessaire pour que le lint global accepte le générateur.
- Horloge déterministe dans `tests/cultureIntelligence.ingest.test.ts`, nécessaire pour que des fixtures datées de septembre 2026 ne dépendent plus de la date réelle d'exécution.

## Règle pour la suite

Les premiers changements du chantier 1 seront limités au dépôt Jarvis. L'exception phase 0 est le spike OIDC isolé : deux nouveaux fichiers sous `Jarvis Desktop/src/auth/` et une politique pure sous `Jarvis APK`, sans dépendance OAuth embarquée. Aucun fichier OpenWakeWord ni réglage Kokoro existant n'a été absorbé ou écrasé.
