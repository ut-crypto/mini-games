/* coi-sw.js を登録し、制御下に入ったら1回だけ再読み込みする */
(() => {
  const KEY = 'coi-reloaded';
  const storage = {
    get() { try { return sessionStorage.getItem(KEY); } catch { return '1'; } },
    set() { try { sessionStorage.setItem(KEY, '1'); } catch { /* 無視 */ } },
    clear() { try { sessionStorage.removeItem(KEY); } catch { /* 無視 */ } },
  };
  if (window.crossOriginIsolated) { storage.clear(); return; }
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

  const reload = () => {
    if (storage.get()) return; // 再読み込みしても有効にならないブラウザではループさせない
    storage.set();
    location.reload();
  };
  // このスクリプトと同じフォルダの coi-sw.js を登録する(サブフォルダのページからも使えるように)
  const swUrl = new URL('coi-sw.js', document.currentScript.src);
  navigator.serviceWorker.register(swUrl.href).then((reg) => {
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener('controllerchange', reload);
    if (reg.active && !navigator.serviceWorker.controller) reload();
  }).catch(() => { /* CPU 対戦が使えないだけなので無視 */ });
})();
