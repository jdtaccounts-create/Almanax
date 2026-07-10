# Almanax

Almanax est une application Windows communautaire, gratuite et non officielle pour préparer les offrandes Almanax de DOFUS sur une période donnée.

## Présentation

Almanax récupère les offrandes par date, les agrège sur la période choisie et construit une liste exploitable d'équipements, consommables et ressources. Quand une offrande ou une ressource est craftable, le plan de craft récursif permet de suivre les crafts principaux, les sous-crafts et les ingrédients nécessaires.

L'application utilise une base locale commune pour les items, recettes, panoplies et images utiles. Une fois la synchronisation terminée, les données nécessaires restent disponibles hors ligne.

## Fonctionnalités

- Chargement des offrandes par jour, période ou mois courant.
- Calendrier intégré pour choisir les dates.
- Agrégation exacte des offrandes et des ressources communes.
- Séparation par équipements, consommables et ressources.
- Quantités possédées ajustables au clavier ou à la molette au survol.
- Cases à cocher synchronisées avec les quantités.
- Plan de craft récursif avec base à craft, sous-crafts et ingrédients.
- Tri enrichi des ressources par récoltables, origines de monstres, familles, types et ordre alphabétique.
- Liens directs vers les fiches DofusDB.
- Modes clair et sombre.
- Synchronisation automatique des données, recettes, panoplies et images utiles.
- Mises à jour automatiques signées.

## Données hors ligne

La base locale commune est stockée dans :

```text
%LOCALAPPDATA%\DofusCompanionData
```

Elle contient le catalogue DofusDB synchronisé, les recettes, les panoplies, les images utiles et les échecs d'images déjà connus. Les images inutiles ou devenues obsolètes sont nettoyées après une synchronisation réussie.

Les offrandes Almanax sont récupérées via l'API publique Dofusdude puis mises en cache localement.

## Télécharger

La dernière version Windows est disponible dans les [releases GitHub](https://github.com/jdtaccounts-create/Almanax/releases/latest).

Fichier recommandé :

- `Almanax_x.x.x_x64-setup.exe` pour l'installation classique Windows.

## Désinstallation

La désinstallation Windows retire l'application installée. Le dossier `%LOCALAPPDATA%\DofusCompanionData` n'est pas supprimé automatiquement, car il peut être partagé par plusieurs outils locaux utilisant les mêmes données DOFUS.

Pour tout supprimer après avoir désinstallé les outils concernés, supprimer manuellement :

```text
%LOCALAPPDATA%\DofusCompanionData
```

## Développement local

```powershell
npm install
npm run smoke
npm run build
npm run dev
```

Ouvrir ensuite `http://127.0.0.1:5175`.

## Publication

La procédure de build signé et de release est décrite dans [RELEASE.md](RELEASE.md). La clé privée de signature ne doit jamais être affichée ni commitée.

## Crédits et droits

Almanax n'est affilié ni à Ankama, ni à DofusDB, ni à Dofusdude. Les crédits détaillés, conditions d'utilisation des données et mentions de droits figurent dans [NOTICE.md](NOTICE.md).
