/*
 * gamevol.js  -  lets the music player's "Game" slider turn a game's sound down.
 *
 * This file goes INSIDE each game page (the tool "Add_Game_Volume.html" adds it for you):
 *     <script src="../m/gamevol.js"></script>      <- must come BEFORE the game's own scripts
 *
 * How it works:
 *  - The player widget (Gam.html) sends the slider value to the game page with postMessage.
 *  - Here we scale every sound the game makes:
 *      * Web Audio (most games, Unity, Construct, Phaser, Howler...): anything connected to the
 *        speakers is routed through one master volume knob.
 *      * <audio>/<video> elements: their .volume is multiplied by the slider value.
 *  - The game still thinks it controls its own volume; we just scale the result.
 *
 * Limits: games that are just a window onto ANOTHER website (an iframe to some other
 * domain) can't be reached - the browser doesn't allow it.
 */
(function () {
  'use strict';
  if (window.__musicaGameVol) return;

  var vol = 1;                                  // 0..1, set by the widget
  var api = window.__musicaGameVol = { get value() { return vol; } };

  function clamp(v) { return Math.min(1, Math.max(0, v)); }

  /* ---------- Web Audio: one master gain per AudioContext ---------- */
  try {
    var NodeProto = window.AudioNode && window.AudioNode.prototype;
    var Dest = window.AudioDestinationNode;
    if (NodeProto && Dest) {
      var origConnect = NodeProto.connect, origDisconnect = NodeProto.disconnect;
      var masters = new WeakMap(), all = [];
      var Offline = window.OfflineAudioContext;

      var masterFor = function (ctx) {
        var m = masters.get(ctx);
        if (!m) {
          m = ctx.createGain();
          m.gain.value = vol;
          origConnect.call(m, ctx.destination);
          masters.set(ctx, m);
          all.push(m);
        }
        return m;
      };
      var isRealDest = function (d) { return d instanceof Dest && !(Offline && d.context instanceof Offline); };

      NodeProto.connect = function (dest) {
        if (isRealDest(dest) && this.context === dest.context) {
          var a = Array.prototype.slice.call(arguments);
          a[0] = masterFor(dest.context);
          return origConnect.apply(this, a);
        }
        return origConnect.apply(this, arguments);
      };
      NodeProto.disconnect = function (dest) {
        if (isRealDest(dest) && this.context === dest.context) {
          var a = Array.prototype.slice.call(arguments);
          a[0] = masterFor(dest.context);
          return origDisconnect.apply(this, a);
        }
        return origDisconnect.apply(this, arguments);
      };
      api._masters = function () { return all.map(function (g) { return g.gain.value; }); };   // for testing
      api._applyWebAudio = function () {
        all.forEach(function (g) {
          try { g.gain.setTargetAtTime(vol, g.context.currentTime, 0.01); } catch (e) { g.gain.value = vol; }
        });
      };
    }
  } catch (e) {}

  /* ---------- <audio> / <video>: scale .volume ---------- */
  var applyMedia = function () {};
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    var wanted = new WeakMap();                  // what the GAME asked for
    var seen = [];                               // elements we've met (weak)
    var remember = function (el) {
      if (!wanted.has(el)) { seen.push(new WeakRef(el)); }
    };
    var effective = function (el) {
      return clamp((wanted.has(el) ? wanted.get(el) : 1) * vol);
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true, enumerable: desc.enumerable,
      get: function () { return wanted.has(this) ? wanted.get(this) : desc.get.call(this); },
      set: function (v) { remember(this); wanted.set(this, v); desc.set.call(this, clamp(v * vol)); }
    });
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      remember(this);
      if (!wanted.has(this)) wanted.set(this, desc.get.call(this));
      try { desc.set.call(this, effective(this)); } catch (e) {}
      return origPlay.apply(this, arguments);
    };
    applyMedia = function () {
      seen = seen.filter(function (r) {
        var el = r.deref();
        if (el) { try { desc.set.call(el, effective(el)); } catch (e) {} }
        return !!el;
      });
      try {
        document.querySelectorAll('audio,video').forEach(function (el) {
          if (!wanted.has(el)) wanted.set(el, desc.get.call(el));
          remember(el);
          desc.set.call(el, effective(el));
        });
      } catch (e) {}
    };
  } catch (e) {}

  function setVol(v) {
    vol = clamp(v);
    if (api._applyWebAudio) api._applyWebAudio();
    applyMedia();
    forward();
  }
  // some media is created after the slider moved: sweep now and then
  setInterval(function () { if (vol !== 1) applyMedia(); }, 700);

  /* ---------- talking to the player widget (parent window) ---------- */
  function forward() {                           // pass the value on to frames inside this game
    var msg = { musicaGameVol: vol };
    try {
      document.querySelectorAll('iframe').forEach(function (f) {
        try { f.contentWindow.postMessage(msg, '*'); } catch (e) {}
      });
    } catch (e) {}
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (typeof m.musicaGameVol === 'number' && e.source === window.parent && window.parent !== window) {
      setVol(m.musicaGameVol);
    } else if (m.musicaGameVolHello && e.source && e.source !== window) {
      try { e.source.postMessage({ musicaGameVol: vol }, '*'); } catch (err) {}   // a frame inside us asks for the value
    }
  });
  if (window.parent !== window) {
    try { window.parent.postMessage({ musicaGameVolHello: 1 }, '*'); } catch (e) {}   // ask the widget for the current value
  }
})();
