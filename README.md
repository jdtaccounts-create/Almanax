# Almanax

Almanax est une application Windows non officielle pour préparer les offrandes Almanax de DOFUS sur une période donnée.

Projet communautaire gratuit, non commercial, non affilié à Ankama, DofusDB ou Dofusdude.

DOFUS et Ankama sont des marques ou propriétés de leurs ayants droit respectifs.

Données d'items et recettes issues de DofusDB. Utilisation soumise à la LPNC-IA 1.0.

Offrandes Almanax récupérées via l'API publique Dofusdude.

Voir aussi [NOTICE.md](NOTICE.md) pour les crédits et notes de droits.

## Avertissement droits

Almanax est un outil communautaire non officiel. Il n'est pas affilié, approuvé, sponsorisé ou maintenu par Ankama, DofusDB, Dofusdude ou leurs ayants droit.

Les noms, visuels, icônes et données liés à DOFUS restent la propriété de leurs ayants droit respectifs. Les données sont utilisées uniquement pour afficher les offrandes, items et crafts dans un cadre gratuit et non commercial.

## Fonctionnalités

- Chargement des offrandes par jour, période ou mois courant.
- Calendrier intégré pour choisir les dates.
- Séparation par équipements, consommables et ressources.
- Cases à cocher pour suivre les items déjà prêts.
- Ouverture directe des fiches DofusDB.
- Plan de craft récursif avec base à craft, sous-crafts et ingrédients.
- Synchronisation locale des items et recettes DofusDB.
- Cache de démarrage embarqué dans `public/data`.
- Mode clair et mode sombre.

## Logique Almanax

L'application récupère les offrandes Almanax via l'API publique Dofusdude.

DofusDB reste utilisé pour la base locale d'items, les recettes, les images, les catégories et l'ouverture des fiches d'items.

## Installer l'application

Télécharge l'application depuis la dernière release :

[Télécharger la dernière version d'Almanax](https://github.com/jdtaccounts-create/Almanax/releases/latest)

Fichier recommandé :

- `Almanax_x.x.x_x64-setup.exe` pour l'installation classique Windows.

Autres fichiers disponibles :

- `Almanax_x.x.x_x64_en-US.msi` pour le format MSI.

## Développement

Prérequis :

- Node.js
- Rust/Cargo

Commandes utiles :

```powershell
npm install
npm run dev
npm run build
npm run smoke
npm run sync:data
npm run tauri -- build
npm run build:signed
```

L'exécutable généré se trouve dans :

```text
src-tauri/target/release/almanax.exe
```

## Données et droits

Cette application utilise l'API publique Dofusdude pour les offrandes Almanax.

Elle utilise aussi des données publiques issues de DofusDB pour les items, recettes, catégories et images d'items.

Le projet est publié à titre non commercial. Il ne doit pas être vendu, monétisé par publicité, abonnement ou intégré dans un service commercial.

Si un ayant droit souhaite une modification, une attribution différente ou le retrait de certains contenus, le dépôt pourra être ajusté en conséquence.
