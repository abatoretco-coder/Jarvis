# Domiciles Jarvis

Chaque domicile possède son propre dossier et un identifiant stable. Le fichier `home.json` est la source canonique ; les fichiers SVG et OBJ sont des rendus générés.

Pour régénérer les rendus d'un domicile :

```powershell
node scripts/generate-home-plan-assets.mjs config/homes/<homeId>/home.json
```

Les coordonnées utilisent des mètres. Elles servent à l'affichage, au placement futur des équipements et à la navigation dans Jarvis. Une géométrie marquée `approximate_from_diagnostics` ne doit pas être utilisée pour des travaux, des achats sur mesure ou un métrage réglementaire.

Les équipements Home Assistant seront associés aux pièces via `automation.spaces[].entities`, sans dupliquer leurs secrets ni leurs comptes de service dans ce fichier.
