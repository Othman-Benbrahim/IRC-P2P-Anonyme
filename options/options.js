// options.js
// Test de fuite d'IP. Signal principal : WebRTC émet-il un candidat contenant
// une IP routable ? Avec ice.proxy_only = true, il ne devrait en émettre AUCUN
// (ou uniquement via le proxy). En bonus, on compare à l'IP HTTPS publique.

const resultEl = document.getElementById("result");

function extractIP(candidateStr) {
  // IPv4 ou IPv6 dans la chaîne de candidat ICE.
  const m = candidateStr.match(/(\d{1,3}(?:\.\d{1,3}){3})/) ||
            candidateStr.match(/([a-f0-9:]+:[a-f0-9:]+)/i);
  return m ? m[1] : null;
}

// Récupère les IP exposées par WebRTC (host + srflx) sur ~3 s.
function gatherWebrtcIPs() {
  return new Promise((resolve) => {
    const ips = new Set();
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      return resolve({ ips: [], error: "RTCPeerConnection indisponible" });
    }
    pc.createDataChannel("leak-test");
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const ip = extractIP(e.candidate.candidate);
      // On ignore les adresses .local (mDNS anonymisées, comportement normal).
      if (ip && !e.candidate.candidate.includes(".local")) ips.add(ip);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => {
      pc.close();
      resolve({ ips: [...ips] });
    }, 3000);
  });
}

async function publicIP() {
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    return (await r.json()).ip;
  } catch {
    return null; // pas de permission réseau, ou proxy bloque : non bloquant
  }
}

document.getElementById("runTest").addEventListener("click", async () => {
  resultEl.className = "result";
  resultEl.textContent = "Test en cours (≈3 s)…";

  const [{ ips, error }, httpIP] = await Promise.all([gatherWebrtcIPs(), publicIP()]);

  if (error) {
    resultEl.className = "result ko";
    resultEl.textContent = "Erreur : " + error;
    return;
  }

  const lines = [];
  lines.push("IP publique (HTTPS) : " + (httpIP || "indéterminée"));
  lines.push("IP exposées par WebRTC : " + (ips.length ? ips.join(", ") : "aucune"));
  lines.push("");

  if (ips.length === 0) {
    resultEl.className = "result ok";
    lines.push("✅ PROTÉGÉ — WebRTC n'expose aucune IP directe.");
    lines.push("(ice.proxy_only semble actif.)");
  } else {
    resultEl.className = "result ko";
    lines.push("⛔ FUITE POSSIBLE — WebRTC révèle une ou plusieurs IP.");
    lines.push("Vérifiez media.peerconnection.ice.proxy_only = true et le proxy.");
  }

  resultEl.textContent = lines.join("\n");
});

