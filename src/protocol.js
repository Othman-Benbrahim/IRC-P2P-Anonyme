// protocol.js
// Format des messages + sérialisation canonique pour la signature.
// Chaque message porte un id (déduplication du mesh) et, s'il est signé,
// { pubkey, ts, sig }.

const Protocol = {
  _id() { return crypto.randomUUID(); },

  nick(nick, pubkey, about) {
    return { type: "nick", id: this._id(), nick, about: about || "", pubkey, ts: Date.now() };
  },
  join(channel) { return { type: "join", channel }; },
  part(channel) { return { type: "part", channel }; },

  // Salon en clair.
  channelmsg(from, channel, text) {
    return { type: "channelmsg", id: this._id(), from, channel, text, ts: Date.now() };
  },
  // Salon chiffré (mot de passe partagé) : texte remplacé par iv+ct.
  channelmsgEnc(from, channel, iv, ct) {
    return { type: "channelmsg", id: this._id(), from, channel, enc: true, iv, ct, ts: Date.now() };
  },
  // DM chiffré (E2E vers un destinataire).
  privmsgEnc(from, to, topubkey, iv, ct) {
    return { type: "privmsg", id: this._id(), from, to, topubkey, iv, ct, ts: Date.now() };
  },
  ping() { return { type: "ping", ts: Date.now() }; },
  pong() { return { type: "pong", ts: Date.now() }; },

  isValid(msg) {
    return msg && typeof msg === "object" && typeof msg.type === "string";
  },

  // Sérialisation DÉTERMINISTE des champs signés (ordre fixe).
  canonical(msg) {
    const order = {
      nick: ["nick", "about"],
      channelmsg: ["from", "channel", "text", "iv", "ct"],
      privmsg: ["from", "to", "topubkey", "iv", "ct"]
    };
    const fields = order[msg.type] || [];
    const arr = [msg.type, ...fields.map((f) => (msg[f] === undefined ? null : msg[f])),
                 msg.id || null, msg.pubkey || null, msg.ts || null];
    return new TextEncoder().encode(JSON.stringify(arr));
  }
};
