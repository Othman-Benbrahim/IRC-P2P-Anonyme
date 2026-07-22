// crypto-utils.js
// Identité + signatures + chiffrement E2E.
//
// UNE seule clé d'identité (ECDSA P-256), réimportée aussi en ECDH : elle sert
// à la fois à SIGNER (authenticité) et à DÉRIVER un secret partagé (chiffrement).
// La clé publique brute (base64) est l'identité "pubkey" du protocole.
//
// - Signature  : ECDSA-SHA256 sur une sérialisation canonique du message.
// - DM chiffré : ECDH(mapriv, sapub) -> HKDF-SHA256 -> AES-GCM 256.
//
// Limite assumée : clés statiques => PAS de forward secrecy (la compromission
// de la clé d'identité expose les anciens DM). Un ratchet type Double Ratchet
// serait l'étape suivante.

const CryptoUtils = {
  privJwk: null,   // clé privée (JWK) réutilisée pour ECDSA et ECDH
  pubB64: null,    // clé publique brute (base64) = identité
  _dmKeys: new Map(), // cache pubkeyPair -> CryptoKey AES-GCM

  async init() {
    const stored = await browser.storage.local.get("identity");
    let kp;
    if (stored.identity) {
      this.privJwk = stored.identity.priv;
      const pub = await crypto.subtle.importKey("jwk", stored.identity.pub,
        { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
      this.pubB64 = this._b64(new Uint8Array(await crypto.subtle.exportKey("raw", pub)));
    } else {
      kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      this.privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
      this.pubB64 = this._b64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
      await browser.storage.local.set({ identity: { priv: this.privJwk, pub: pubJwk } });
    }
  },

  publicKeyId() { return this.pubB64; },

  // --- Signature ---
  async _signKey() {
    return crypto.subtle.importKey("jwk", this.privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  },
  async sign(bytes) {
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this._signKey(), bytes);
    return this._b64(new Uint8Array(sig));
  },
  async verify(peerPubB64, sigB64, bytes) {
    try {
      const key = await crypto.subtle.importKey("raw", this._unb64(peerPubB64),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, this._unb64(sigB64), bytes);
    } catch { return false; }
  },

  // --- Chiffrement DM (ECDH -> HKDF -> AES-GCM) ---
  async _dmKey(peerPubB64) {
    if (this._dmKeys.has(peerPubB64)) return this._dmKeys.get(peerPubB64);
    const ecdhPriv = await crypto.subtle.importKey("jwk",
      { kty: this.privJwk.kty, crv: this.privJwk.crv, x: this.privJwk.x, y: this.privJwk.y, d: this.privJwk.d },
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const ecdhPub = await crypto.subtle.importKey("raw", this._unb64(peerPubB64),
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: ecdhPub }, ecdhPriv, 256);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("ircp2p-dm-v1") },
      hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    this._dmKeys.set(peerPubB64, key);
    return key;
  },
  async encryptFor(peerPubB64, plaintext) {
    const key = await this._dmKey(peerPubB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
    return { iv: this._b64(iv), ct: this._b64(new Uint8Array(ct)) };
  },
  async decryptFrom(peerPubB64, ivB64, ctB64) {
    const key = await this._dmKey(peerPubB64);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: this._unb64(ivB64) }, key, this._unb64(ctB64));
    return new TextDecoder().decode(pt);
  },

  // --- Clé de salon (mot de passe partagé -> PBKDF2 -> AES-GCM) ---
  _chanKeys: new Map(),
  async setChannelKey(channel, passphrase) {
    if (!passphrase) { this._chanKeys.delete(channel); return; }
    const salt = new TextEncoder().encode("ircp2p-chan:" + channel);
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    this._chanKeys.set(channel, key);
  },
  hasChannelKey(channel) { return this._chanKeys.has(channel); },
  async encryptChannel(channel, text) {
    const key = this._chanKeys.get(channel);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return { iv: this._b64(iv), ct: this._b64(new Uint8Array(ct)) };
  },
  async decryptChannel(channel, ivB64, ctB64) {
    const key = this._chanKeys.get(channel);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: this._unb64(ivB64) }, key, this._unb64(ctB64));
    return new TextDecoder().decode(pt);
  },

  // --- base64 <-> octets ---
  _b64(u8) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); },
  _unb64(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
};
