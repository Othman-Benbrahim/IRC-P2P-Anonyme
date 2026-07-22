// chat.js — UI de l'app. Appelle directement Engine (moteur in-page) et écoute
// ses événements. Aucune messagerie inter-contexte : les connexions vivent ici.

const $ = (s) => document.querySelector(s);
const LINK_PREFIX = "irc-p2p://";

let log = [], channels = [], presenceArr = [], dmThreads = new Set();
let myNick = "anon";
let selected = { kind: "channel", name: "#general" };
const unread = new Map();

function targetKey(t) { return t.kind + ":" + t.name; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
function esc(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function matches(e, t) {
  if (t.kind === "channel") return e.type === "channelmsg" && e.channel === t.name;
  return e.type === "privmsg" && ((e.dir === "in" && e.from === t.name) || (e.dir === "out" && e.to === t.name));
}

function renderSidebar() {
  const cl = $("#chanList"); cl.innerHTML = "";
  for (const c of channels) {
    const li = document.createElement("li");
    if (selected.kind === "channel" && selected.name === c.name) li.classList.add("active");
    const u = unread.get("channel:" + c.name) || 0;
    li.innerHTML = `<span class="grow">${c.locked ? "🔒 " : ""}${esc(c.name)}</span>` + (u ? `<span class="badge">${u}</span>` : "") + `<span class="x" title="Quitter">×</span>`;
    li.querySelector(".grow").onclick = () => select({ kind: "channel", name: c.name });
    li.querySelector(".x").onclick = (ev) => { ev.stopPropagation(); Engine.partChannel(c.name); };
    cl.appendChild(li);
  }
  for (const nick of dmThreads) {
    const li = document.createElement("li");
    if (selected.kind === "dm" && selected.name === nick) li.classList.add("active");
    const u = unread.get("dm:" + nick) || 0;
    li.innerHTML = `<span class="grow">🔒 ${esc(nick)}</span>` + (u ? `<span class="badge">${u}</span>` : "");
    li.onclick = () => select({ kind: "dm", name: nick });
    cl.appendChild(li);
  }
  const pl = $("#presList"); pl.innerHTML = "";
  for (const p of presenceArr) {
    if (p.nick === myNick) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot ${p.online ? "on" : ""}"></span><span class="grow">${esc(p.nick)}` + (p.about ? `<div class="sub">${esc(p.about)}</div>` : "") + `</span>`;
    li.title = "Message privé à " + p.nick;
    li.onclick = () => { dmThreads.add(p.nick); select({ kind: "dm", name: p.nick }); };
    pl.appendChild(li);
  }
}

function renderFeed() {
  const feed = $("#feed"); feed.innerHTML = "";
  const t = selected;
  $("#target").innerHTML = t.kind === "channel"
    ? `${(channels.find((c) => c.name === t.name) || {}).locked ? "🔒 " : ""}${esc(t.name)}`
    : `Message privé — ${esc(t.name)} 🔒`;
  for (const e of log) if (matches(e, t)) appendLine(e);
  feed.scrollTop = feed.scrollHeight;
}

function appendLine(e) {
  const feed = $("#feed");
  const div = document.createElement("div");
  div.className = "line " + (e.dir === "in" ? "in" : "out");
  let badge = "";
  if (e.warning) badge += `<span class="b warn" title="${esc(e.warning)}">⚠</span>`;
  if (e.encrypted) badge += `<span class="b enc" title="chiffré">🔒</span>`;
  if (e.verified && !e.warning) badge += `<span class="b ok" title="signature vérifiée">✓</span>`;
  const who = e.dir === "in" ? (e.from || "?") : myNick;
  div.innerHTML = `${badge}<span class="who">${esc(who)}</span> ${esc(e.text)}<span class="ts">${fmtTime(e.ts)}</span>`;
  feed.appendChild(div); feed.scrollTop = feed.scrollHeight;
}

function select(t) { selected = t; unread.delete(targetKey(t)); renderSidebar(); renderFeed(); $("#msg").focus(); }

// --- Événements du moteur ---
function wireEngine() {
  Engine.on("chat", (e) => {
    log.push(e);
    if (e.type === "privmsg") dmThreads.add(e.dir === "in" ? e.from : e.to);
    const t = e.type === "channelmsg" ? { kind: "channel", name: e.channel } : { kind: "dm", name: e.dir === "in" ? e.from : e.to };
    if (targetKey(t) === targetKey(selected)) appendLine(e);
    else { unread.set(targetKey(t), (unread.get(targetKey(t)) || 0) + 1); renderSidebar(); }
  });
  Engine.on("channels", (c) => { channels = c; if (selected.kind === "channel" && !channels.find((x) => x.name === selected.name)) selected = { kind: "channel", name: (channels[0] || {}).name || "#general" }; renderSidebar(); renderFeed(); });
  Engine.on("presence", (p) => { presenceArr = p; renderSidebar(); });
  Engine.on("discovery-status", (s) => setNet(s));
}

function setNet(s) {
  const el = $("#netStatus");
  if (s.active) el.textContent = "🟢 connecté (" + (s.peerId || "").slice(0, 8) + "…)";
  else el.textContent = s.error ? "🔴 " + s.error : "inactif";
}

// --- Démarrage ---
(async () => {
  wireEngine();
  await Engine.init();
  const st = Engine.getState();
  myNick = st.nick; $("#nick").value = st.nick; $("#about").value = st.about || "";
  channels = st.channels; presenceArr = st.presence; log = st.log;
  for (const e of log) if (e.type === "privmsg") dmThreads.add(e.dir === "in" ? e.from : e.to);
  const d = await Engine.getDiscovery();
  $("#netName").value = d.config.network || ""; $("#netStrategy").value = d.config.strategy || "nostr";
  $("#relayUrls").value = (d.config.relayUrls || []).join("\n");
  renderDefaults($("#netStrategy").value);
  if (d.active) $("#netStatus").textContent = "🟢 connecté";
  renderSidebar(); renderFeed();
})();

// --- Interactions ---
$("#saveProfile").onclick = async () => { const r = await Engine.setProfile($("#nick").value.trim() || "anon", $("#about").value.trim()); myNick = r.nick; renderSidebar(); };
$("#addChan").onclick = () => { const f = $("#chanForm"); f.hidden = !f.hidden; if (!f.hidden) $("#chanName").focus(); };
$("#chanJoin").onclick = async () => {
  const name = $("#chanName").value.trim(); if (!name) return;
  const ch = await Engine.joinChannel(name, $("#chanPass").value);
  $("#chanName").value = ""; $("#chanPass").value = ""; $("#chanForm").hidden = true;
  select({ kind: "channel", name: ch });
};
$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#msg").value.trim(); if (!text) return;
  try {
    if (selected.kind === "channel") await Engine.sendChannel(selected.name, text);
    else await Engine.sendDm(selected.name, text);
    $("#msg").value = "";
  } catch (err) { const d = document.createElement("div"); d.className = "sys"; d.textContent = "Erreur : " + err.message; $("#feed").appendChild(d); }
};
$("#opts").onclick = () => browser.runtime.openOptionsPage();

// --- Découverte auto ---
$("#netConnect").onclick = async () => {
  const network = $("#netName").value.trim();
  if (!network) { $("#netStatus").textContent = "choisis un nom de réseau"; return; }
  const all = $("#relayUrls").value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  // Seuls les WebSocket sécurisés (wss://) fonctionnent en navigateur.
  const relayUrls = all.filter((u) => /^wss:\/\//i.test(u));
  const ignored = all.length - relayUrls.length;
  if (relayUrls.length) $("#relayUrls").value = relayUrls.join("\n"); // ne garde que les valides
  $("#netStatus").textContent = "connexion…" + (ignored ? ` (${ignored} URL non-wss:// ignorée${ignored > 1 ? "s" : ""})` : "");
  await Engine.setDiscovery({ mode: "trystero", network, strategy: $("#netStrategy").value, relayUrls });
};
$("#netOff").onclick = async () => { await Engine.setDiscovery({ mode: "off" }); $("#netStatus").textContent = "inactif"; };

// Liste des relais/trackers par défaut (cliquer pour ajouter au champ).
function currentUrls() { return new Set($("#relayUrls").value.split(/\s+/).map((s) => s.trim()).filter(Boolean)); }
function addUrl(url) {
  const set = currentUrls(); set.add(url);
  $("#relayUrls").value = [...set].join("\n");
}
function renderDefaults(strategy) {
  const box = $("#defaultRelays"); box.innerHTML = "";
  const list = ((typeof TrysteroDiscovery !== "undefined" && TrysteroDiscovery.defaults) || {})[strategy] || [];
  for (const url of list) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "chip"; chip.textContent = url.replace(/^wss:\/\//, "");
    chip.title = url;
    chip.onclick = () => addUrl(url);
    box.appendChild(chip);
  }
}
$("#netStrategy").addEventListener("change", () => renderDefaults($("#netStrategy").value));
$("#addAll").addEventListener("click", (e) => {
  e.preventDefault();
  const list = ((typeof TrysteroDiscovery !== "undefined" && TrysteroDiscovery.defaults) || {})[$("#netStrategy").value] || [];
  const set = currentUrls(); list.forEach((u) => set.add(u));
  $("#relayUrls").value = [...set].join("\n");
});
renderDefaults($("#netStrategy").value);

// --- Appairage manuel (modale) ---
const modal = $("#pairModal");
$("#openPair").onclick = () => { modal.hidden = false; };
$("#pairClose").onclick = () => { modal.hidden = true; };
modal.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
  modal.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  modal.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
  t.classList.add("active"); $("#" + t.dataset.tab).classList.add("active");
});

function renderQr(imgEl, text) {
  try { const qr = qrcode(0, "L"); qr.addData(text); qr.make(); imgEl.src = qr.createDataURL(5, 12); imgEl.hidden = false; return true; }
  catch { imgEl.hidden = true; return false; }
}
async function copyText(el, label, statusEl) {
  try { await navigator.clipboard.writeText(el.value); } catch { el.select(); document.execCommand("copy"); }
  statusEl.textContent = label + " copié.";
}
function cleanLink(s) { return (s || "").trim().replace(new RegExp("^" + LINK_PREFIX, "i"), ""); }
async function scanOnce(videoEl, onResult, statusEl) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
  catch (e) { statusEl.textContent = "Caméra indisponible : collez le lien. (" + e.message + ")"; return; }
  videoEl.hidden = false; videoEl.srcObject = stream; await videoEl.play();
  const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); videoEl.srcObject = null; videoEl.hidden = true; };
  (function tick() {
    if (stopped) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (code && code.data) { stop(); onResult(code.data); return; }
    }
    requestAnimationFrame(tick);
  })();
}

$("#genInvite").onclick = async () => {
  $("#initStatus").textContent = "Génération…";
  try {
    const blob = await Engine.createInvite();
    const link = LINK_PREFIX + blob;
    $("#inviteLink").value = link; $("#inviteOut").hidden = false;
    const ok = renderQr($("#inviteQr"), link); await copyText($("#inviteLink"), "Invitation", $("#initStatus"));
    $("#initStatus").textContent = ok ? "Invitation prête et copiée." : "Invitation prête (QR trop dense : lien copié).";
  } catch (e) { $("#initStatus").textContent = "Erreur : " + e.message; }
};
$("#copyInvite").onclick = () => copyText($("#inviteLink"), "Invitation", $("#initStatus"));
$("#scanAnswer").onclick = () => scanOnce($("#answerCam"), (d) => { $("#answerIn").value = d; $("#initStatus").textContent = "Réponse scannée."; }, $("#initStatus"));
$("#finalize").onclick = async () => {
  const blob = cleanLink($("#answerIn").value); if (!blob) return;
  $("#initStatus").textContent = "Finalisation…";
  try { await Engine.completeInvite(blob); $("#initStatus").textContent = "✅ Connexion établie."; setTimeout(() => modal.hidden = true, 1200); }
  catch (e) { $("#initStatus").textContent = "Erreur : " + e.message; }
};
$("#scanInvite").onclick = () => scanOnce($("#inviteCam"), (d) => { $("#inviteIn").value = d; $("#joinStatus").textContent = "Invitation scannée."; }, $("#joinStatus"));
$("#genAnswer").onclick = async () => {
  const blob = cleanLink($("#inviteIn").value); if (!blob) return;
  $("#joinStatus").textContent = "Génération…";
  try {
    const b = await Engine.acceptInvite(blob);
    const link = LINK_PREFIX + b;
    $("#answerLink").value = link; $("#answerOut").hidden = false;
    const ok = renderQr($("#answerQr"), link); await copyText($("#answerLink"), "Réponse", $("#joinStatus"));
    $("#joinStatus").textContent = ok ? "Réponse prête et copiée." : "Réponse prête (QR trop dense : lien copié).";
  } catch (e) { $("#joinStatus").textContent = "Erreur : " + e.message; }
};
$("#copyAnswer").onclick = () => copyText($("#answerLink"), "Réponse", $("#joinStatus"));
