# Sauvegarde et restauration SQLite — procédure vérifiée

Date : 2026-10-06.

## Commandes

Sauvegarde cohérente d'une base active en WAL :

```powershell
npm run db:conversation -- backup --source <conversation.sqlite> --destination <nouvelle-sauvegarde.sqlite>
```

Vérification :

```powershell
npm run db:conversation -- verify --source <sauvegarde.sqlite>
```

Restauration : arrêter Jarvis, déplacer la base actuelle vers un emplacement de quarantaine explicite, puis :

```powershell
npm run db:conversation -- restore --source <sauvegarde.sqlite> --destination <nouvelle-conversation.sqlite>
```

Les commandes refusent d'écraser une destination existante. La sauvegarde utilise l'API online backup de SQLite, puis `PRAGMA quick_check`; la restauration vérifie la source et la copie avant renommage atomique.

## Drill réalisé

Source historique : `D:\Projets\NAS\All VM\conv.sqlite`, schéma pré-registre version `0`.

- 17 threads ;
- 43 messages ;
- sauvegarde et restauration : `quick_check = ok` ;
- SHA-256 sauvegarde/restauration : `5DB2D437B2BA058F925EC3872EBB9BF34C712922D94A108B0A76D35F5649EF3D`.

La source n'a pas été modifiée. Les copies techniques du drill ont été supprimées après enregistrement du hash et des compteurs afin de ne pas conserver une duplication inutile des données.
