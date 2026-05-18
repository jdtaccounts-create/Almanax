# Almanax

Almanax est une application Windows non officielle pour préparer les offrandes Almanax de DOFUS sur une période donnée.

Projet communautaire gratuit, non commercial, non affilié à Ankama ni à DofusDB.

DOFUS et Ankama sont des marques ou propriétés de leurs ayants droit respectifs.

Données issues de DofusDB. Utilisation soumise à la LPNC-IA 1.0.

Voir aussi [NOTICE.md](NOTICE.md) pour les crédits et notes de droits.

## Avertissement droits

Almanax est un outil communautaire non officiel. Il n'est pas affilié, approuvé, sponsorisé ou maintenu par Ankama, DofusDB ou leurs ayants droit.

Les noms, visuels, icônes et données liés à DOFUS restent la propriété de leurs ayants droit respectifs. Les données DofusDB sont utilisées uniquement pour afficher les offrandes, items et crafts dans un cadre gratuit et non commercial.

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

L'application privilégie la collection `almanax-calendars` de DofusDB pour résoudre les offrandes via les dates fixes `DD/MM/*`.

Si aucune entrée de calendrier n'est trouvée, elle retombe sur les endpoints journaliers :

```text
/almanax?date=MM/DD/*
/almanax?date=MM/DD/YYYY
```

Cette stratégie évite les cas où la recherche exacte par année renvoie une offrande décalée.

## Installer l'application

Télécharge l'application depuis la dernière release :

[Télécharger Almanax v0.1.0](https://github.com/jdtaccounts-create/Almanax2/releases/tag/v0.1.0)

Fichier recommandé :

- `Almanax_0.1.0_x64-setup.exe` pour l'installation classique Windows.

Autres fichiers disponibles :

- `Almanax_0.1.0_x64_en-US.msi` pour le format MSI.
- `almanax.exe` pour lancer l'application directement sans installeur.

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
```

L'exécutable généré se trouve dans :

```text
src-tauri/target/release/almanax.exe
```

## Données et droits

Cette application utilise des données publiques issues de DofusDB pour les offrandes Almanax, items, recettes, catégories et images d'items.

Le projet est publié à titre non commercial. Il ne doit pas être vendu, monétisé par publicité, abonnement ou intégré dans un service commercial.

Si un ayant droit souhaite une modification, une attribution différente ou le retrait de certains contenus, le dépôt pourra être ajusté en conséquence.
