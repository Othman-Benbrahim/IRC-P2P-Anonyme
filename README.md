# IRC P2P Anonyme — réseau social P2P décentralisé

Add-on Firefox : réseau IRC décentralisé en P2P (WebRTC), **sans serveur**.
Salons publics ou chiffrés, messages privés chiffrés, présence, profils.


## Onglet épinglé, démarrage auto, reconnexion

- L'app s'ouvre dans un **onglet épinglé** ; garde-le ouvert pour rester en ligne.
- Elle se **rouvre automatiquement au démarrage de Firefox** (sans doublon : si un
  onglet du réseau existe déjà, il est simplement focalisé).
- La **découverte se reconnecte seule** : un chien de garde relance le réseau
  public s'il tombe, et rejoindre l'onglet réapplique ta config sauvegardée.
- Les liens WebRTC appairés manuellement ne se rétablissent pas seuls (pas de
  canal de signalisation) ; mais avec la découverte auto activée, les pairs se
  retrouvent automatiquement.

## Architecture (important)

Le moteur P2P (connexions WebRTC, mesh, crypto, découverte) tourne **dans la
fenêtre de l'application**, pas dans l'arrière-plan. Raison : en MV3, la page
d'arrière-plan de Firefox se met en veille quand elle est inactive, ce qui
coupait les connexions. Conséquence : **tu es en ligne tant que la fenêtre du
réseau est ouverte** — comme n'importe quelle app de chat. La fermer = se
déconnecter. Il n'y a plus d'arrière-plan.

## Charger l'add-on

1. Ouvrez `about:debugging#/runtime/this-firefox`
2. « Charger un module temporaire… » → sélectionnez `manifest.json`
3. Cliquez l'icône → **Ouvrir le réseau** (la fenêtre de l'app s'ouvre).

## Deux façons de se connecter

**A. Découverte automatique (sans rien héberger).** Dans l'app, section
« Connexion » : saisis un **nom de réseau secret**, choisis **Nostr** ou
**BitTorrent** (relais/trackers publics), clique « Découverte auto ». Tous ceux
qui saisissent le même nom se retrouvent automatiquement.

**B. Appairage manuel (zéro dépendance).** Section « Connexion » →
**📷 Appairer manuellement**. Onglet « J'invite » : *Générer l'invitation*
(QR + lien). Onglet « Je rejoins » sur l'autre appareil : scanner/coller
l'invitation → *Générer la réponse* (QR + lien) → revenir sur le premier →
scanner/coller la réponse → *Finaliser*. La connexion vit dans la fenêtre, donc
l'échange en plusieurs étapes ne « périme » plus. Le lien est compressé (gzip)
pour tenir dans un QR.


> Astuce debug : la même machine, deux profils, fonctionne très bien en local
> même **sans** proxy (les candidats `host` locaux suffisent).

## Anonymat

Voir la page d'options (⚙). La config `about:config` est manuelle (une extension
ne peut pas la modifier). Le test de fuite vérifie que WebRTC n'expose pas d'IP.

## Découverte automatique — sans rien héberger (Trystero)

Deux modes coexistent :

- **Manuel** (QR / lien) — sans aucune infrastructure, décrit ci-dessus.
- **Automatique** (Trystero) — les pairs se retrouvent seuls via des **trackers
  BitTorrent** ou **relais Nostr publics**. Tu n'héberges rien.

Pour l'activer : ⚙ Options → « Découverte automatique (réseau public) » :

1. Choisis un **nom de réseau** secret (il sert aussi de mot de passe de mise en
   relation : tous ceux qui saisissent le même nom se retrouvent).
2. Choisis la stratégie **Nostr** ou **BitTorrent** (si l'une ne connecte pas,
   essaie l'autre).
3. « Se connecter ». Fais pareil dans chaque instance : les salons/DM circulent
   alors automatiquement.

**Architecture :** tout le monde rejoint la même « room » Trystero = ton réseau.
Les salons et DM restent gérés par-dessus (champ `channel` + chiffrement), comme
pour le mesh manuel. Les messages voyagent en **WebRTC direct** entre pairs ; les
trackers/relais publics ne servent qu'à la mise en relation.

**À savoir :** tu dépends de tiers publics (disponibilité variable ; un opérateur
de relais voit des métadonnées de mise en relation, jamais tes messages qui sont
chiffrés). Choisis un nom de réseau peu devinable.

> Bundle : `vendor/discovery-trystero.bundle.js` (≈150 Ko, déjà compilé).
> L'ancienne piste libp2p (relais auto-hébergé, dossier `relay/` + gros bundle)
> reste dans l'archive pour référence mais n'est pas chargée par défaut.

## Persistance (Phase 3)

L'historique du chat et les pairs connus sont stockés en **IndexedDB**
(`src/storage.js`). Les messages survivent au redémarrage ; les 200 derniers
sont réaffichés à l'ouverture. Bouton d'effacement via la commande
`clear-history` (à brancher dans l'UI si souhaité).

## L'application « réseau » (écran à part)

Dans le popup, cliquez sur **⛶** pour ouvrir le réseau dans une **fenêtre
séparée** — l'interface complète, bien plus confortable que le popup. Tant que
cette fenêtre reste ouverte, elle garde le moteur P2P actif en arrière-plan
(les connexions restent stables).

Elle réunit :

- **Salons multiples** — colonne de gauche. Bouton **＋** pour rejoindre ou créer
  un salon (nom + mot de passe optionnel). Un salon avec mot de passe est chiffré
  (🔒) ; sans mot de passe il est public. Chaque salon a son fil de messages.
- **Présence** — liste « En ligne » (pastille verte = actif récemment). Les pairs
  s'annoncent périodiquement (battement de présence signé). Cliquez un pseudo
  pour lui envoyer un **message privé chiffré**.
- **Profil** — pseudo + statut, en haut à gauche, persistés et diffusés aux
  autres (signés).
- **Messages privés** — chaque conversation privée a son propre fil, chiffré E2E.

## Un réseau à plusieurs (mesh), sans serveur

L'appairage crée des liens 1:1. Pour un vrai réseau, les messages sont **relayés
de pair en pair** : si A↔B et B↔C sont appairés, A et C se parlent *à travers* B.
Chaque message a un identifiant unique et une liste « déjà vu » empêche les
boucles (déduplication). Résultat : le graphe des appairages devient un réseau.

**Onboarding :** un nouveau venu s'appaire **une seule fois** (QR/lien) avec
n'importe quel membre déjà présent ; le mesh propage ensuite ses messages à tous.
Pas besoin d'appairer tout le monde entre soi.

**Limite honnête :** ce mesh dépend des « ponts ». Si le seul pair qui relie deux
groupes se déconnecte, le réseau se scinde. Pour une découverte automatique et
robuste à grande échelle, il faudrait un point de rendez-vous (le relais libp2p
de la Phase 3, optionnel) — mais ça sort du « zéro infra ».

## Sécurité (Phase 4)

Chaque message est **signé** (ECDSA P-256) ; badges dans le chat : **✓** vérifié,
**🔒** chiffré, **⚠** problème (signature invalide ou usurpation de pseudo).

**Salons chiffrés.** Tapez `/key <motdepasse>` : `#general` devient chiffré
(mot de passe partagé → PBKDF2 → AES-GCM). Seuls ceux qui ont le mot de passe
lisent ; les autres pairs relaient quand même le message chiffré sans pouvoir le
lire. `/key` sans argument repasse le salon en clair. Le mot de passe se partage
**hors ligne** (de vive voix, autre canal).

**DM chiffrés.** `/msg <pseudo> <texte>` chiffre pour ce seul destinataire
(ECDH → AES-GCM). Il faut avoir déjà reçu un message signé de ce pseudo.

`/help` rappelle les commandes.

**Limites assumées** (tu as indiqué qu'elles ne sont pas prioritaires) : pas de
forward secrecy (clés statiques) ; le mot de passe d'un salon ne peut pas être
« révoqué » (un ancien membre qui l'a noté peut déchiffrer les futurs messages
tant qu'il n'est pas changé) ; TOFU protège après le premier contact seulement.

## Ce qui reste à faire

- Découverte automatique optionnelle (relais libp2p déjà présent) pour ne plus
  dépendre des « ponts » du mesh.
- Rotation de la clé de salon, anti-spam / rate-limit.
- Fil persistant plus riche (pièces jointes, réactions), notifications.

## Note d'architecture

Le background Firefox MV3 est une *event page* avec DOM : `RTCPeerConnection`
y fonctionne, ce qui permet d'héberger les connexions hors du popup. En revanche
l'event page se décharge à l'inactivité — pour une persistance longue, il faudra
la maintenir éveillée ou déplacer WebRTC dans un onglet dédié.
