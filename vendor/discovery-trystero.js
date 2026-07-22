// discovery-trystero.js  (source ESM -> bundlé en IIFE global `TrysteroDiscovery`)
//
// Découverte automatique SANS rien héberger : Trystero met les navigateurs en
// relation via des trackers BitTorrent ou des relais Nostr PUBLICS. Tu ne fais
// tourner aucun serveur.
//
// Modèle : tout le monde rejoint la même "room" = ton réseau. Le nom du réseau
// sert aussi de mot de passe Trystero -> le trafic de signalisation est chiffré
// pour ceux qui connaissent le nom. Les salons/DM restent gérés par-dessus
// (champ `channel` + chiffrement applicatif), exactement comme le mesh manuel.
//
// ⚠️ Dépendances de tiers publics : disponibilité variable, et l'opérateur d'un
// relais voit des métadonnées de mise en relation (pas tes messages, chiffrés).

import { joinRoom as joinNostr, selfId as nostrId, defaultRelayUrls as nostrDefaults } from "@trystero-p2p/nostr";
import { joinRoom as joinTorrent, selfId as torrentId, defaultRelayUrls as torrentDefaults } from "@trystero-p2p/torrent";

const APP_ID = "ircp2p-net";

class TrysteroDiscovery {
  constructor() { this.room = null; this._send = null; }

  // config: { network, strategy, relayUrls? }
  async start({ network, strategy, relayUrls }, { onMessage, onPeer } = {}) {
    const join = strategy === "torrent" ? joinTorrent : joinNostr;
    const selfId = strategy === "torrent" ? torrentId : nostrId;

    // Le nom du réseau chiffre aussi la signalisation (password).
    const config = { appId: APP_ID, password: network };
    // Relais Nostr / trackers BitTorrent personnalisés (sinon les publics par défaut).
    if (relayUrls && relayUrls.length) config.relayConfig = { urls: relayUrls };
    this.room = join(config, network);

    // API 0.25 : makeAction renvoie un OBJET { send, onMessage }, pas un tuple.
    const action = this.room.makeAction("m");
    this._send = (data) => action.send(data);
    action.onMessage = (payload) => { if (onMessage) onMessage({ msg: payload }); };

    this.room.onPeerJoin = (id) => onPeer && onPeer({ id, state: "connect" });
    this.room.onPeerLeave = (id) => onPeer && onPeer({ id, state: "disconnect" });

    return selfId;
  }

  // Les salons sont gérés au niveau applicatif : ici tout passe par la room.
  joinChannel() {}
  partChannel() {}

  // Diffuse un message (objet) à tous les pairs de la room.
  async publish(_channel, msgObj) { if (this._send) await this._send(msgObj); }

  async stop() { if (this.room) { try { this.room.leave(); } catch {} this.room = null; this._send = null; } }
}

export { TrysteroDiscovery };
// Listes par défaut (relais Nostr / trackers BitTorrent) pour l'affichage UI.
export const defaults = { nostr: nostrDefaults, torrent: torrentDefaults };
