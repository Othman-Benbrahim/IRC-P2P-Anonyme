// peer-manager.js
// Cœur P2P. Phase 1 : signalisation MANUELLE par copier-coller.
//
// Astuce clé : on utilise l'ICE "non-trickle". On attend que la collecte des
// candidats ICE soit terminée AVANT de sérialiser la description locale. Ainsi
// tout tient dans UN SEUL blob à copier — pas d'échange de candidats séparé.
//
// Flux :
//   A: createInvite()      -> blob "offre"     (A envoie à B)
//   B: acceptInvite(blob)  -> blob "réponse"   (B renvoie à A)
//   A: completeInvite(blob)-> connexion établie
//
// IMPORTANT anonymat : PAS de serveur STUN/TURN par défaut. Avec
// media.peerconnection.ice.proxy_only = true, seuls les candidats passant par
// le proxy sont émis. On garde iceServers vide pour ne rien fuiter.

class PeerManager {
  constructor(onEvent) {
    this.peers = new Map();        // connId -> { pc, channel, nick }
    this.pending = new Map();      // connId (côté A) -> { pc }
    this.onEvent = onEvent;        // callback(eventName, payload)
  }

  // --- Côté A : créer une invitation ---
  async createInvite() {
    const connId = crypto.randomUUID();
    const pc = this._newPeerConnection();
    const channel = pc.createDataChannel("irc-p2p", { ordered: true });
    this._wireChannel(connId, pc, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIceComplete(pc);

    this.pending.set(connId, { pc });
    return await this._pack({ connId, role: "offer", sdp: pc.localDescription });
  }

  // --- Côté B : accepter une invitation, produire la réponse ---
  async acceptInvite(blob) {
    const { connId, sdp } = await this._unpack(blob);
    const pc = this._newPeerConnection();

    // Côté B, le canal arrive via ondatachannel (créé par A).
    pc.ondatachannel = (e) => this._wireChannel(connId, pc, e.channel);

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitIceComplete(pc);

    this.peers.set(connId, { pc, channel: null, nick: null });
    return await this._pack({ connId, role: "answer", sdp: pc.localDescription });
  }

  // --- Côté A : finaliser avec la réponse de B ---
  async completeInvite(blob) {
    const { connId, sdp } = await this._unpack(blob);
    const p = this.pending.get(connId);
    if (!p) throw new Error("Invitation inconnue ou expirée.");
    await p.pc.setRemoteDescription(sdp);
    this.pending.delete(connId);
  }

  // Envoi vers un pair précis.
  send(connId, message) {
    const peer = this.peers.get(connId);
    if (peer && peer.channel && peer.channel.readyState === "open") {
      peer.channel.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // Diffusion à tous les pairs connectés (filtrage par salon fait en amont).
  broadcast(message) {
    for (const connId of this.peers.keys()) this.send(connId, message);
  }

  listPeers() {
    return [...this.peers.entries()].map(([id, p]) => ({
      connId: id,
      nick: p.nick,
      open: !!(p.channel && p.channel.readyState === "open")
    }));
  }

  // --- interne ---
  _newPeerConnection() {
    // iceServers vide = aucune requête vers un tiers = pas de fuite hors proxy.
    return new RTCPeerConnection({ iceServers: [] });
  }

  _wireChannel(connId, pc, channel) {
    const rec = this.peers.get(connId) || { pc, channel: null, nick: null };
    rec.channel = channel;
    rec.pc = pc;
    this.peers.set(connId, rec);

    channel.onopen = () => this.onEvent("peer-open", { connId });
    channel.onclose = () => {
      this.peers.delete(connId);
      this.onEvent("peer-close", { connId });
    };
    channel.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!Protocol.isValid(msg)) return;
      if (msg.type === "nick") {
        const r = this.peers.get(connId);
        if (r) r.nick = msg.nick;
      }
      this.onEvent("message", { connId, msg });
    };
  }

  // Attend la fin de la collecte ICE (ou timeout de sécurité).
  _waitIceComplete(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(done, 3000); // ne bloque jamais l'UI plus de 3 s
    });
  }

  // Sérialise un objet en blob base64 compact (copier-coller facile).
  // Sérialise en base64 compressé (gzip) : blobs plus courts, QR possibles.
  async _pack(obj) {
    const bytes = await this._gzip(JSON.stringify(obj));
    return this._bytesToB64(bytes);
  }
  async _unpack(blob) {
    // Tolère un préfixe de lien et les espaces/retours à la ligne.
    let clean = (blob || "").trim().replace(/^irc-p2p:\/\//i, "").replace(/\s+/g, "");
    if (!clean) throw new Error("Aucun texte fourni.");

    let bytes;
    try {
      bytes = this._b64ToBytes(clean);
    } catch {
      throw new Error("Blob illisible (caractères invalides). Recopiez-le entièrement.");
    }
    let json;
    try {
      json = await this._gunzip(bytes);
    } catch {
      throw new Error("Blob incomplet ou corrompu : recollez la TOTALITÉ du texte / rescannez le QR.");
    }
    try {
      return JSON.parse(json);
    } catch {
      throw new Error("Contenu invalide après décompression.");
    }
  }

  // --- compression via l'API navigateur (dispo dans le background) ---
  async _gzip(str) {
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(str));
    w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  }
  async _gunzip(u8) {
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(u8);
    w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  _bytesToB64(u8) {
    let s = "";
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  }
  _b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
}
