/* gams-boot.js - keeps the game's frame loop running when the tab is hidden.
   Without this, V-Slice stops on its loading screen until you click it, because
   Chrome pauses requestAnimationFrame in background/uncovered windows. */
(function () {
  if (window.__gamsRafFix) return;
  window.__gamsRafFix = true;
  var rawRaf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  var rawCancel = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : null;
  if (!rawRaf) return;
  var nextId = 1,
      pending = {},
      nativeIds = {},
      lastNative = Date.now();
  function fire(id, t) {
    var item = pending[id];
    if (!item || item.done) return;
    item.done = true;
    delete pending[id];
    delete nativeIds[id];
    try { item.cb(t); } catch (e) { setTimeout(function () { throw e; }, 0); }
  }
  window.requestAnimationFrame = function (cb) {
    var id = nextId++;
    pending[id] = { cb: cb, done: false };
    nativeIds[id] = rawRaf(function (t) { lastNative = Date.now(); fire(id, t); });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (pending[id]) { pending[id].done = true; delete pending[id]; }
    var n = nativeIds[id];
    if (n != null) { delete nativeIds[id]; if (rawCancel) rawCancel(n); }
  };
  function pump() {
    if (!document.hidden && Date.now() - lastNative < 250) return;  /* real frames are flowing */
    var ids = Object.keys(pending), now = Date.now();
    for (var i = 0; i < ids.length; i++) fire(ids[i], now);
  }
  setInterval(pump, 50);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pump(); });
  window.addEventListener("focus", pump);
  window.addEventListener("click", pump, true);
})();
