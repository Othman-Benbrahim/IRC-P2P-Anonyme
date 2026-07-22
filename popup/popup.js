// popup.js — lanceur. Demande au mini arrière-plan d'ouvrir (ou focaliser)
// l'onglet épinglé du réseau, pour éviter les doublons.
document.getElementById("openWindow").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ action: "open-app" });
  window.close();
});
document.getElementById("openOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
