// startup.js — mini arrière-plan au rôle unique : ouvrir l'app dans un onglet
// épinglé au démarrage de Firefox (et éviter les doublons). Il peut se mettre en
// veille sans problème : les connexions P2P vivent dans l'onglet de l'app.

const APP_URL = browser.runtime.getURL("app/chat.html");

async function openApp() {
  try {
    const tabs = await browser.tabs.query({ url: APP_URL });
    if (tabs && tabs.length) {
      await browser.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) await browser.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch {}
  await browser.tabs.create({ url: APP_URL, pinned: true });
}

// Ouverture automatique au démarrage de Firefox et à l'installation.
browser.runtime.onStartup.addListener(openApp);
browser.runtime.onInstalled.addListener(openApp);

// Le popup (lanceur) demande l'ouverture via ce message.
browser.runtime.onMessage.addListener((m) => {
  if (m && m.action === "open-app") { openApp(); return Promise.resolve({ ok: true }); }
});
