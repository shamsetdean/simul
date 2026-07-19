# simul

Capture un souvenir en immersif : les deux cameras a la fois (ou une capture
rapide alternee si le simultane n'est pas possible), ancre sur une carte du
lieu, avec les personnes presentes taguees. 100% local, rien ne sort du
telephone. PWA vanilla, zero dependance.

## Lancer en local

Il faut servir les fichiers en HTTP (pas en `file://`) car `getUserMedia`
et le service worker l'exigent :

```bash
cd simul
python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080` sur le telephone (meme reseau) ou via
un tunnel HTTPS (ex. `ngrok`) — **HTTPS obligatoire pour la camera et la
geoloc en dehors de localhost**.

Pour un usage reel, deploiement sur GitHub Pages (HTTPS natif) comme les
autres projets Anthropotech Lab.

## Comportement par mode

- **Capture simultanee** : deux `getUserMedia` ouverts en parallele
  (`environment` + `user`). Fonctionne sur la majorite des Android recents.
  Le flux avant s'affiche en PiP en incrustation.
- **Capture rapide alternee** : fallback automatique (iOS Safari, ou tout
  appareil qui refuse le double flux). Le badge en haut a gauche indique
  toujours honnetement quel mode est actif — jamais de simultane simule.

## Points a valider / tester sur appareil reel

1. **Permissions** : le premier lancement demande deux autorisations camera
   (potentiellement deux popups successives) + une geoloc. A tester sur
   iOS Safari et Android Chrome pour voir le comportement des prompts.
2. **Video en mode simultane** : l'enregistrement video compose live le
   PiP sur un canvas (`captureStream`) — plus gourmand en CPU/batterie que
   la photo. A profiler sur un appareil moyen de gamme.
3. **Tuiles OSM** : usage direct de `tile.openstreetmap.org` sans clef.
   Correct pour un usage personnel/perso, mais l'OSM tile usage policy
   deconseille un usage a grande echelle sans self-hosting ou fournisseur
   dedie (MapTiler, etc.) si l'appli devait grandir.
4. **Icones** : `icons/icon-192.png` et `icon-512.png` sont des placeholders
   generes automatiquement (degrade violet/bleu/vert) — a remplacer par une
   vraie identite si tu veux publier l'app.
5. **Web Share API avec fichiers** : supportee sur mobile (iOS Safari,
   Android Chrome) mais pas partout sur desktop — le fallback `sms:` ne
   joint pas le fichier automatiquement (limitation du protocole `sms:`
   lui-meme, pas de notre code). A verifier si un message d'instruction
   supplementaire est utile dans ce cas ("le media a ete telecharge,
   joins-le manuellement").

## Prochaines etapes possibles

- Export/telechargement direct du souvenir (en plus du partage)
- Filtrage de la galerie par tag (l'index IndexedDB `by_tags` existe deja)
- Reglages : qualite video, zoom niveau carte, desactiver la geoloc par defaut
- Synchro multi-appareils plus tard (Supabase), sans casser le mode local
