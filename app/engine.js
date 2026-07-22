// engine.js — Moteur P2P exécuté DANS la fenêtre de l'app (contexte stable qui
// ne se met pas en veille, contrairement à l'arrière-plan MV3). C'est ici que
// vivent les connexions WebRTC, le mesh, la crypto, la persistance, la découverte.
// L'UI (chat.js) appelle directement les méthodes de Engine et écoute ses events.

const Engine = {
  peerManager: null,
  discovery: null, discoveryPeerId: null,
  myNick: "anon", myAbout: "", myPubkey: null,
  messageLog: [],
  nickToPub: new Map(),
  joinedChannels: new Set(),
  presence: new Map(),
  _seen: new Set(), _seenOrder: [],
  _listeners: {},

  // --- mini émetteur d'événements ---
  on(event, cb) { (this._listeners[event] ||= []).push(cb); },
  emit(event, payload) { for (const cb of (this._listeners[event] || [])) { try { cb(payload); } catch {} } },

  _markSeen(id) {
    if (!id) return false;
    if (this._seen.has(id)) return true;
    this._seen.add(id); this._seenOrder.push(id);
    if (this._seenOrder.length > 8000) for (let i = 0; i < 2000; i++) this._seen.delete(this._seenOrder.shift());
    return false;
  },

  _record(entry) {
    this.messageLog.push(entry);
    Storage.addMessage(entry).then(() => Storage.pruneIfNeeded()).catch(() => {});
    this.emit("chat", entry);
  },

  presenceList() {
    const now = Date.now();
    return [...this.presence.values()].map((p) => ({ nick: p.nick, about: p.about, online: (now - p.lastSeen) < 150000, lastSeen: p.lastSeen }))
      .sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  },
  channelList() { return [...this.joinedChannels].map((c) => ({ name: c, locked: CryptoUtils.hasChannelKey(c) })); },

  async _sign(msg) { msg.pubkey = this.myPubkey; if (!msg.ts) msg.ts = Date.now(); msg.sig = await CryptoUtils.sign(Protocol.canonical(msg)); return msg; },
  _originate(msg) { this._markSeen(msg.id); this.peerManager.broadcast(msg); if (this.discovery) this.discovery.publish(msg.channel || "#general", msg).catch(() => {}); },
  _relay(msg, exceptConnId) { for (const p of this.peerManager.listPeers()) if (p.connId !== exceptConnId && p.open) this.peerManager.send(p.connId, msg); },
  async _announce() { this._originate(await this._sign(Protocol.nick(this.myNick, this.myPubkey, this.myAbout))); },

  async _incoming(msg, sourceConnId) {
    if (!Protocol.isValid(msg)) return;
    if (msg.type === "ping" || msg.type === "pong") return;
    if (this._markSeen(msg.id)) return;

    let verified = false;
    if (msg.pubkey && msg.sig) verified = await CryptoUtils.verify(msg.pubkey, msg.sig, Protocol.canonical(msg));

    let warning = null;
    const claimed = msg.nick || msg.from;
    if (claimed && msg.pubkey && verified) {
      const known = this.nickToPub.get(claimed);
      if (known && known !== msg.pubkey) warning = "usurpation possible : pseudo déjà associé à une autre clé";
      else if (!known) { this.nickToPub.set(claimed, msg.pubkey); this.emit("known", [...this.nickToPub.keys()]); }
      const prev = this.presence.get(msg.pubkey) || {};
      this.presence.set(msg.pubkey, { nick: claimed, about: (msg.type === "nick" ? msg.about : prev.about) || "", lastSeen: Date.now() });
      Storage.savePeer({ pubkey: msg.pubkey, nick: claimed, about: msg.about || prev.about || "", lastSeen: Date.now() }).catch(() => {});
      this.emit("presence", this.presenceList());
    } else if (msg.pubkey && !verified) warning = "signature invalide";

    if (verified && sourceConnId != null && (msg.type === "channelmsg" || msg.type === "privmsg" || msg.type === "nick"))
      this._relay(msg, sourceConnId);

    if (msg.type === "nick") return;

    if (msg.type === "channelmsg") {
      if (!this.joinedChannels.has(msg.channel)) return;
      let text = msg.text, encrypted = false;
      if (msg.enc) {
        if (!CryptoUtils.hasChannelKey(msg.channel)) return;
        encrypted = true;
        try { text = await CryptoUtils.decryptChannel(msg.channel, msg.iv, msg.ct); }
        catch { text = "[déchiffrement salon impossible]"; warning = warning || "clé de salon invalide"; }
      }
      this._record({ dir: "in", type: "channelmsg", from: msg.from, channel: msg.channel, text, ts: msg.ts, verified, encrypted, warning });
    } else if (msg.type === "privmsg") {
      if (msg.topubkey !== this.myPubkey) return;
      let text;
      try { text = await CryptoUtils.decryptFrom(msg.pubkey, msg.iv, msg.ct); }
      catch { text = "[déchiffrement impossible]"; warning = warning || "déchiffrement échoué"; }
      this._record({ dir: "in", type: "privmsg", from: msg.from, to: this.myNick, text, ts: msg.ts, verified, encrypted: true, warning });
    }
  },

  _onPeerEvent(name, data) {
    if (name === "peer-open") { this._announce().catch(() => {}); this.emit("peers", this.peerManager.listPeers()); }
    if (name === "peer-close") this.emit("peers", this.peerManager.listPeers());
    if (name === "message") {
      if (data.msg && data.msg.type === "ping") { this.peerManager.send(data.connId, Protocol.pong()); return; }
      this._incoming(data.msg, data.connId).catch(() => {});
      this.emit("peers", this.peerManager.listPeers());
    }
  },

  // --- Découverte publique (Trystero) ---
  async _stopDiscovery() { if (this.discovery) { try { await this.discovery.stop(); } catch {} this.discovery = null; this.discoveryPeerId = null; } },
  async startTrystero({ network, strategy, relayUrls }) {
    if (!network) return;
    if (typeof TrysteroDiscovery === "undefined") { this.emit("discovery-status", { active: false, error: "bundle Trystero absent" }); return; }
    await this._stopDiscovery();
    this.discovery = new TrysteroDiscovery.TrysteroDiscovery();
    try {
      this.discoveryPeerId = await this.discovery.start({ network, strategy, relayUrls }, {
        onMessage: ({ msg }) => this._incoming(msg, null).catch(() => {}),
        onPeer: (p) => { this.emit("net", p); if (p.state === "connect") this._announce().catch(() => {}); }
      });
      await this._announce();
      this.emit("discovery-status", { active: true, peerId: this.discoveryPeerId, mode: "trystero" });
    } catch (err) { this.emit("discovery-status", { active: false, error: String(err.message || err) }); this.discovery = null; }
  },

  // --- API publique appelée par l'UI ---
  async init() {
    await CryptoUtils.init();
    this.myPubkey = CryptoUtils.publicKeyId();
    await Storage.init();
    this.messageLog.push(...await Storage.getRecentMessages(400));
    for (const p of await Storage.getPeers()) if (p.nick && p.pubkey) this.nickToPub.set(p.nick, p.pubkey);
    this.peerManager = new PeerManager((n, d) => this._onPeerEvent(n, d));
    const saved = await browser.storage.local.get(["nick", "about", "chanPass", "channels", "discoveryConfig"]);
    if (saved.nick) this.myNick = saved.nick;
    if (saved.about) this.myAbout = saved.about;
    const chans = saved.channels && saved.channels.length ? saved.channels : ["#general"];
    for (const c of chans) this.joinedChannels.add(c);
    if (saved.chanPass) for (const [ch, pass] of Object.entries(saved.chanPass)) await CryptoUtils.setChannelKey(ch, pass);
    const dc = saved.discoveryConfig;
    if (dc && dc.mode === "trystero" && dc.network) this.startTrystero(dc).catch(() => {});
    // Battement de présence (la fenêtre reste ouverte -> setInterval fiable).
    setInterval(() => { this._announce().catch(() => {}); this.emit("presence", this.presenceList()); }, 60000);
    // Chien de garde : si la découverte est configurée mais tombée, on la relance.
    setInterval(async () => {
      try {
        const s = await browser.storage.local.get("discoveryConfig");
        const dc = s.discoveryConfig;
        if (dc && dc.mode === "trystero" && dc.network && !this.discovery) {
          this.emit("discovery-status", { active: false, error: "reconnexion…" });
          await this.startTrystero(dc);
        }
      } catch {}
    }, 20000);
  },

  getState() { return { nick: this.myNick, about: this.myAbout, pubkey: this.myPubkey, channels: this.channelList(), presence: this.presenceList(), log: this.messageLog }; },
  knownNicks() { return [...this.nickToPub.keys()]; },

  async setProfile(nick, about) {
    this.myNick = (nick || "anon").trim(); this.myAbout = (about || "").slice(0, 140);
    await browser.storage.local.set({ nick: this.myNick, about: this.myAbout });
    await this._announce();
    return { nick: this.myNick, about: this.myAbout };
  },
  async joinChannel(channel, passphrase) {
    const ch = channel.startsWith("#") ? channel : "#" + channel;
    this.joinedChannels.add(ch);
    if (passphrase) await CryptoUtils.setChannelKey(ch, passphrase);
    const s = await browser.storage.local.get("chanPass"); const cp = s.chanPass || {};
    if (passphrase) cp[ch] = passphrase;
    await browser.storage.local.set({ channels: [...this.joinedChannels], chanPass: cp });
    if (this.discovery) this.discovery.joinChannel(ch);
    await this._announce();
    this.emit("channels", this.channelList());
    return ch;
  },
  async partChannel(ch) {
    this.joinedChannels.delete(ch);
    await CryptoUtils.setChannelKey(ch, null);
    const s = await browser.storage.local.get("chanPass"); const cp = s.chanPass || {}; delete cp[ch];
    await browser.storage.local.set({ channels: [...this.joinedChannels], chanPass: cp });
    if (this.discovery) this.discovery.partChannel(ch);
    this.emit("channels", this.channelList());
  },
  async setChannelKey(ch, passphrase) {
    this.joinedChannels.add(ch);
    await CryptoUtils.setChannelKey(ch, passphrase);
    const s = await browser.storage.local.get("chanPass"); const cp = s.chanPass || {};
    if (passphrase) cp[ch] = passphrase; else delete cp[ch];
    await browser.storage.local.set({ chanPass: cp, channels: [...this.joinedChannels] });
    this.emit("channels", this.channelList());
    return CryptoUtils.hasChannelKey(ch);
  },
  async sendChannel(ch, text) {
    let m;
    if (CryptoUtils.hasChannelKey(ch)) { const { iv, ct } = await CryptoUtils.encryptChannel(ch, text); m = await this._sign(Protocol.channelmsgEnc(this.myNick, ch, iv, ct)); }
    else m = await this._sign(Protocol.channelmsg(this.myNick, ch, text));
    this._originate(m);
    this._record({ dir: "out", type: "channelmsg", from: this.myNick, channel: ch, text, ts: m.ts, verified: true, encrypted: !!m.enc, warning: null });
  },
  async sendDm(nick, text) {
    const topub = this.nickToPub.get(nick);
    if (!topub) throw new Error("Pseudo inconnu : aucune clé reçue de « " + nick + " ».");
    const { iv, ct } = await CryptoUtils.encryptFor(topub, text);
    const m = await this._sign(Protocol.privmsgEnc(this.myNick, nick, topub, iv, ct));
    this._originate(m);
    this._record({ dir: "out", type: "privmsg", from: this.myNick, to: nick, text, ts: m.ts, verified: true, encrypted: true, warning: null });
  },

  // Appairage : la connexion vit ici, dans la fenêtre -> survit à tout l'échange.
  createInvite() { return this.peerManager.createInvite(); },
  acceptInvite(blob) { return this.peerManager.acceptInvite(blob); },
  completeInvite(blob) { return this.peerManager.completeInvite(blob); },

  async setDiscovery(cfg) {
    const c = { mode: cfg.mode || "off", network: (cfg.network || "").trim(), strategy: cfg.strategy || "nostr", relayUrls: Array.isArray(cfg.relayUrls) ? cfg.relayUrls.filter(Boolean) : [] };
    await browser.storage.local.set({ discoveryConfig: c });
    await this._stopDiscovery();
    if (c.mode === "trystero" && c.network) await this.startTrystero(c);
    return { active: !!this.discovery, mode: c.mode };
  },
  async getDiscovery() { const s = await browser.storage.local.get("discoveryConfig"); return { config: s.discoveryConfig || { mode: "off", network: "", strategy: "nostr", relayUrls: [] }, active: !!this.discovery }; }
};
