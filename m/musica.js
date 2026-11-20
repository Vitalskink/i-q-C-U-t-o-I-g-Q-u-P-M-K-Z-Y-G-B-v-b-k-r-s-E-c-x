/*
 * musica.js  -  shared music engine + floating player for Gams
 *
 * Add ONE line to any page (path depends on where the page lives):
 *     <script src="m/musica.js"></script>          (pages in the root folder)
 *     <script src="../../m/musica.js"></script>    (g/g/Gam.html)
 *     <script src="../musica.js"></script>         (pages inside /m/)
 *
 * Start a song from any page with:
 *     Musica.play({ src: "m/Eminem/Rap_God.mp3", title: "Rap God",
 *                   artist: "Eminem", img: "m/Eminem/Rap_God.png" });
 * (src / img are paths from the ROOT Gams folder, so they work from any page.)
 *
 * How it keeps music going while you move around:
 *  - The current song is saved in localStorage ("musica_state"), so when you go
 *    to another page it picks up again at the right second.
 *  - Tabs talk through a BroadcastChannel. Only ONE tab actually makes sound
 *    (the "owner"); every other tab shows the same widget and just sends it
 *    commands. If the owner tab closes, another tab takes over automatically.
 *    That is why music keeps playing in the menu tab while you play a game in
 *    a new tab (and you can pause it from the game tab).
 *  - It never touches your other settings (the "gams" localStorage key).
 */
(function () {
  'use strict';
  if (window.Musica) return;

  var SCRIPT = document.currentScript;
  var ROOT = (window.CG && window.CG.root) || new URL('../', SCRIPT && SCRIPT.src ? SCRIPT.src : location.href).href;   // CG.root = single-file build

  var KEY = 'musica_state';      // { track, status, time, savedAt }
  var VOL_KEY = 'musica_volume'; // 0..1
  var MIN_KEY = 'musica_min';    // per-tab (sessionStorage): widget minimized?
  var MAX_AGE = 6 * 3600 * 1000; // forget a saved song after 6 hours

  var myId = Math.random().toString(36).slice(2);
  var chan = null;
  try { chan = new BroadcastChannel('musica'); } catch (e) {}

  var audio = new Audio();
  audio.preload = 'auto';

  var role = 'remote';           // 'owner' (makes sound) or 'remote' (just a controller)
  var track = null;              // { src, title, artist, img }
  var remoteView = { status: 'paused', time: 0, dur: 0 };
  var wantPlay = false;
  var single = true;   // true = one song played on its own -> repeats when it ends
  var queue = null, qi = 0, qname = '';   // playlist queue (owner side)
  var shuffled = false;                    // true = endless shuffle (a new random order every round)
  var trackStart = 0, trackEnd = 0;        // where the real sound starts / ends (silence before and after is skipped); 0 = none
  var endHandled = false;
  var remoteQ = { name: '', i: 0, n: 0, shuf: false };  // queue info as seen by remote tabs
  var lastState = 0;             // when we last heard from an owner
  var gestureArmed = false;
  var claimToken = 0;            // cancels a takeover that is still waiting
  var lastTakeoverAt = 0;        // throttles the "owner vanished" interval
  var WAS_OWNER = 'musica_was_owner'; // sessionStorage flag: this tab was making the sound

  /* ---------- helpers ---------- */
  function abs(p) {
    if (!p) return '';
    if (/^(https?:|data:|blob:|file:)/i.test(p)) return p;
    return new URL(p, ROOT).href;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function post(m) { if (chan) { try { chan.postMessage(m); } catch (e) {} } }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function getVol() {
    var v = parseFloat(lsGet(VOL_KEY));
    return isNaN(v) ? 0.8 : Math.min(1, Math.max(0, v));
  }

  function loadSaved() {
    try {
      var s = JSON.parse(lsGet(KEY));
      if (s && s.track && s.track.src && Date.now() - s.savedAt < MAX_AGE) return s;
    } catch (e) {}
    return null;
  }
  function save() {
    if (role !== 'owner' || !track) return;   // a controller tab must never overwrite the song
    lsSet(KEY, JSON.stringify({
      track: track,
      status: wantPlay ? 'playing' : 'paused',
      time: audio.currentTime || 0,
      queue: queue, qi: qi, qname: qname, single: single, shuffled: shuffled,
      savedAt: Date.now()
    }));
  }
  function markOwner() { try { sessionStorage.setItem(WAS_OWNER, '1'); } catch (e) {} }
  function wasOwnerHere() { try { return sessionStorage.getItem(WAS_OWNER) === '1'; } catch (e) { return false; } }

  /* ---------- what the widget should show ---------- */
  function view() {
    if (role === 'owner') {
      var d = isFinite(audio.duration) ? audio.duration : 0;
      if (trackEnd > 0 && d && trackEnd < d) d = trackEnd;
      var st = trackStart || 0;
      return {
        status: audio.paused ? 'paused' : 'playing',
        time: Math.max(0, (audio.currentTime || 0) - st),
        dur: Math.max(0, d - st)
      };
    }
    return remoteView;
  }

  /* ---------- owner side (the tab that makes sound) ---------- */
  function armGesture() {
    // Browsers may block autoplay after a page change. Retry on the next click/key.
    if (gestureArmed) return;
    gestureArmed = true;
    var retry = function () {
      document.removeEventListener('pointerdown', retry, true);
      document.removeEventListener('keydown', retry, true);
      gestureArmed = false;
      if (role === 'owner' && wantPlay && audio.paused) tryPlay();
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('keydown', retry, true);
  }
  function tryPlay() {
    if (!track) return;
    var p = audio.play();
    if (p && p.catch) p.catch(function () { armGesture(); render(); });
  }
  function retryWanted() {
    if (role === 'owner' && wantPlay && track && audio.paused) tryPlay();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) retryWanted(); });
  window.addEventListener('focus', retryWanted);

  function qInfo() {
    if (role !== 'owner') return remoteQ;
    var cur = queue && queue[qi];
    return { name: qname, i: cur && cur.pos ? cur.pos - 1 : qi, n: queue ? queue.length : 0, shuf: shuffled };
  }

  function announce() {
    if (role !== 'owner' || !track) return;
    var v = view();
    post({ t: 'state', id: myId, track: track, status: v.status, time: v.time, dur: v.dur, q: qInfo() });
  }

  /* ---------- offline library ----------
   * Songs packed by the "<Artist>_music.html" bundles are stored in the browser's own
   * database (IndexedDB "musica_library") under their normal path, e.g. "m/Eminem/Rap_God.mp3".
   * If a song is in there we play it from there, otherwise we play the normal file.     */
  var libDB = null;
  function libOpen() {
    if (!libDB) libDB = new Promise(function (res) {
      try {
        var r = indexedDB.open('musica_library', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('songs'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return libDB;
  }
  /* The single-file Music.html stores everything in the database "cg_music" (files + chunks). */
  var vfsDB = null;
  function vfsOpen() {
    if (!vfsDB) vfsDB = new Promise(function (res) {
      try {
        var r = indexedDB.open('cg_music', 1);
        r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('meta'); d.createObjectStore('files'); d.createObjectStore('chunks'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return vfsDB;
  }
  function vfsGet(path) {
    return vfsOpen().then(function (db) {
      if (!db || !db.objectStoreNames.contains('files')) return null;
      return new Promise(function (res) {
        try {
          var tx = db.transaction(['files', 'chunks'], 'readonly'), fr = tx.objectStore('files').get(path);
          fr.onerror = function () { res(null); };
          fr.onsuccess = function () {
            var meta = fr.result; if (!meta || !meta.n) { res(null); return; }
            var parts = [], left = meta.n;
            for (var i = 0; i < meta.n; i++) (function (i) {
              var cr = tx.objectStore('chunks').get([path, i]);
              cr.onsuccess = function () {
                parts[i] = cr.result;
                if (--left === 0) {
                  if (parts.some(function (x) { return !x; })) { res(null); return; }
                  var b = new Blob(parts, { type: meta.mime }); b.cgPath = path; b.cgTrim = meta.trim; res(b);
                }
              };
              cr.onerror = function () { res(null); };
            })(i);
          };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }

  // Looks through a decoded song for its first and last real sound. Returns [start, end] in seconds (0 = nothing to skip).
  // Only skips a quiet lead-in of 1 s or more and a silent tail of 2 s or more, and keeps a small margin around the sound.
  function findTrim(a) {
    var sr = a.sampleRate, n = a.length, W = Math.max(1, Math.floor(sr * 0.02)), TH = 0.001, ch = [], c, i, e, st;
    for (c = 0; c < a.numberOfChannels; c++) ch.push(a.getChannelData(c));
    function loud(from, to) {
      for (var k = 0; k < ch.length; k++) { var d = ch[k]; for (var j = from; j < to; j++) { var v = d[j] < 0 ? -d[j] : d[j]; if (v > TH) return true; } }
      return false;
    }
    var first = -1, last = -1;
    for (st = 0; st < n; st += W) if (loud(st, Math.min(n, st + W))) { first = st / sr; break; }
    if (first < 0) return [0, 0];                                    // all silence: leave the song alone
    for (e = n; e > 0; e -= W) if (loud(Math.max(0, e - W), e)) { last = e / sr; break; }
    var dur = n / sr, start = first >= 1.0 ? Math.max(0, first - 0.15) : 0, end = (dur - last >= 2.0) ? Math.min(dur, last + 0.4) : 0;
    if (end && end < start + 1) end = 0;
    return [Math.round(start * 100) / 100, Math.round(end * 100) / 100];
  }
  function saveTrim(path, t) {
    vfsOpen().then(function (db) {
      if (!db || !db.objectStoreNames.contains('files')) return;
      try {
        var tx = db.transaction('files', 'readwrite'), st = tx.objectStore('files'), g = st.get(path);
        g.onsuccess = function () { var m = g.result; if (m) { m.trim = [t[0], t[1], 1]; st.put(m, path); } };
      } catch (e) {}
    });
  }
  // first time a song is played: look at it in the background, remember the result for next time
  function learnTrim(blob, path, token, fresh) {
    blob.arrayBuffer().then(function (buf) { return new OfflineAudioContext(2, 1, 22050).decodeAudioData(buf); }).then(function (a) {
      var t = findTrim(a); saveTrim(path, t);
      if (token !== srcToken || role !== 'owner') return;
      trackStart = t[0]; trackEnd = t[1];
      if (fresh && trackStart > 0 && (audio.currentTime || 0) < trackStart) { try { audio.currentTime = trackStart; } catch (e) {} }
      render(); announce();
    }).catch(function () {});
  }

  function libGet(path) {
    return vfsGet(path).then(function (b) { return b || libGetOld(path); });
  }
  function libGetOld(path) {
    return libOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var rq = db.transaction('songs', 'readonly').objectStore('songs').get(path);
          rq.onsuccess = function () { res(rq.result && rq.result.blob ? rq.result.blob : null); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }

  var srcToken = 0, objUrl = null;
  function releaseUrl() { if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} objUrl = null; } }

  function startOwner(t, time, play) {
    role = 'owner';
    markOwner();
    claimToken++;                 // a takeover that was waiting is no longer needed
    track = t;
    wantPlay = !!play;
    audio.volume = getVol();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    trackStart = 0; trackEnd = 0; endHandled = false;
    var token = ++srcToken, fresh = !(time > 0);
    libGet(t.src).then(function (blob) {
      if (token !== srcToken) return;                 // a different song was picked meanwhile
      releaseUrl();
      if (blob && blob.cgTrim) { trackStart = blob.cgTrim[0] || 0; trackEnd = blob.cgTrim[1] || 0; }
      else if (blob && blob.cgPath && blob.size < 80e6) learnTrim(blob, blob.cgPath, token, fresh);
      if (blob) { objUrl = URL.createObjectURL(blob); audio.src = objUrl; }   // from the browser's library
      else audio.src = abs(t.src);                                            // from the normal file
      audio.addEventListener('loadedmetadata', function onMeta() {
        audio.removeEventListener('loadedmetadata', onMeta);
        if (time > 0 && (!isFinite(audio.duration) || time < audio.duration)) {
          try { audio.currentTime = time; } catch (e) {}
        } else if (trackStart > 0) {
          try { audio.currentTime = trackStart; } catch (e) {}          // skip the silent lead-in
        }
      });
      if (wantPlay) tryPlay();
      render(); announce();
    });
    save();
    render();
    announce();
  }

  function demote() {
    queue = null; qi = 0; qname = ''; shuffled = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    role = 'remote';
    wantPlay = false;
  }

  // Take over playing the saved song (used on page load / when the owner tab goes away)
  // auto=true  -> nobody asked for this; only continue a song that was actually playing
  // forcePlay  -> the user pressed Play on a song that was saved paused
  function claimFromSaved(auto, forcePlay) {
    var s = loadSaved();
    if (!s || !s.track) return false;
    if (auto && s.status !== 'playing') return false;        // never take over a paused song
    if (auto && Date.now() - lastState < 1200) return false;  // an owner is still here
    var t = s.time || 0;
    if (s.status === 'playing') t += (Date.now() - s.savedAt) / 1000;
    queue = (s.queue && s.queue.length > 1) ? s.queue : null;
    qi = queue ? (s.qi || 0) : 0;
    qname = queue ? (s.qname || '') : '';
    shuffled = !!(queue && s.shuffled);
    single = !queue && s.single !== false;
    startOwner(s.track, t, !!forcePlay || s.status === 'playing');
    return true;
  }
  // Show a saved song without owning it (used when the owner tab is gone and the song
  // was paused, so a fresh tab does not quietly write a new state and stop the music).
  function adoptSaved() {
    var s = loadSaved();
    if (!s || !s.track) return false;
    track = s.track;
    remoteView = { status: 'paused', time: s.time || 0, dur: 0 };
    queue = (s.queue && s.queue.length > 1) ? s.queue : null;
    qi = queue ? (s.qi || 0) : 0;
    qname = queue ? (s.qname || '') : '';
    shuffled = !!(queue && s.shuffled);
    single = !queue && s.single !== false;
    remoteQ = { name: qname, i: qi, n: queue ? queue.length : 0, shuf: shuffled };
    return true;
  }

  function ownerStop() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    srcToken++; releaseUrl(); trackStart = 0; trackEnd = 0;
    wantPlay = false;
    track = null;
    queue = null; qi = 0; qname = ''; shuffled = false;
    lsDel(KEY);
    post({ t: 'stopped' });
    render();
  }

  function onTrackEnd() {
    if (endHandled) return;
    endHandled = true;
    if (queue && (qi < queue.length - 1 || shuffled)) { next(); return; }   // playlist: go to the next song (a shuffle keeps going)
    if (single && track) {                                    // a single song: repeat it
      try { audio.currentTime = trackStart || 0; } catch (e) {}
      endHandled = false; wantPlay = true; tryPlay(); save(); announce();
      return;
    }
    wantPlay = false;
    audio.pause();                                            // (the silent tail may still be "playing")
    try { audio.currentTime = trackStart || 0; } catch (e) {}
    save(); render(); announce();
  }
  audio.addEventListener('play', function () { endHandled = false; render(); announce(); });
  audio.addEventListener('pause', function () { render(); announce(); });
  audio.addEventListener('timeupdate', function () {
    if (trackEnd > 0 && !endHandled && role === 'owner' && audio.currentTime >= trackEnd) { onTrackEnd(); return; }
    render();
  });
  audio.addEventListener('ended', onTrackEnd);
  audio.addEventListener('error', function () { render(); });

  /* ---------- public actions (work from owner OR remote tabs) ---------- */
  function play(t) {
    if (!t || !t.src) return;
    var clean = { src: t.src, title: t.title || 'Unknown', artist: t.artist || '', img: t.img || '' };
    post({ t: 'claim', id: myId, user: true });   // any other tab making sound steps aside
    if (role === 'owner' && audio.src) audio.pause();
    queue = null; qi = 0; qname = ''; shuffled = false; single = true;
    startOwner(clean, 0, true);
  }
  function shuffleList(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // a shuffle never runs out: after the last song, everything is shuffled again (and the song that just played is not first)
  function reshuffle() {
    var last = queue[queue.length - 1];
    var a = shuffleList(queue.slice().sort(function (x, y) { return (x.pos || 0) - (y.pos || 0); }));
    if (a.length > 1 && last && a[0].src === last.src) { var k = 1 + Math.floor(Math.random() * (a.length - 1)), t = a[0]; a[0] = a[k]; a[k] = t; }
    queue = a; qi = 0;
  }
  // Play a list of songs one after another. opts: { startIndex, shuffle, name }
  function playQueue(list, opts) {
    opts = opts || {};
    var tracks = (list || []).filter(function (t) { return t && t.src; }).map(function (t) {
      return { src: t.src, title: t.title || 'Unknown', artist: t.artist || '', img: t.img || '' };
    });
    tracks.forEach(function (t, i) { t.pos = i + 1; });                    // its place in the list, for the "5/6" counter
    if (!tracks.length) return;
    var start = Math.min(Math.max(opts.startIndex || 0, 0), tracks.length - 1);
    if (opts.shuffle) { tracks = shuffleList(tracks); start = 0; }
    post({ t: 'claim', id: myId, user: true });
    if (role === 'owner' && audio.src) audio.pause();
    single = false;
    shuffled = !!opts.shuffle && tracks.length > 1;
    queue = tracks.length > 1 ? tracks : null;
    qi = queue ? start : 0;
    qname = opts.name || '';
    startOwner(tracks[start], 0, true);
  }
  function next() {
    if (role === 'owner') {
      if (queue && qi < queue.length - 1) { qi++; startOwner(queue[qi], 0, true); }
      else if (queue && shuffled) { reshuffle(); startOwner(queue[qi], 0, true); }
    } else post({ t: 'cmd', c: 'next' });
  }
  function prev() {
    if (role === 'owner') {
      if (queue && qi > 0 && (audio.currentTime || 0) <= 3) { qi--; startOwner(queue[qi], 0, true); }
      else seek(0);
    } else post({ t: 'cmd', c: 'prev' });
  }
  function toggle() {
    if (!track) return;
    if (role === 'owner') {
      if (audio.paused) { wantPlay = true; tryPlay(); } else { wantPlay = false; audio.pause(); }
      save(); render(); announce();
    } else if (Date.now() - lastState > 2000) {
      // no owner is answering: this click turns this tab into the player
      var want = view().status !== 'playing';
      if (claimFromSaved(false, want)) {
        if (!want) { wantPlay = false; audio.pause(); }
        save(); render(); announce();
      }
    } else post({ t: 'cmd', c: 'toggle' });
  }
  function pause() { if (view().status === 'playing') toggle(); }
  function resume() { if (view().status !== 'playing') toggle(); }
  function stop() {
    if (role === 'owner') ownerStop();
    else { post({ t: 'cmd', c: 'stop' }); track = null; render(); }
  }
  function seek(sec) {
    if (role === 'owner') { try { audio.currentTime = sec + (trackStart || 0); } catch (e) {} save(); announce(); }
    else post({ t: 'cmd', c: 'seek', v: sec });
  }
  function setVolume(v) {
    lsSet(VOL_KEY, String(v));
    if (role === 'owner') audio.volume = v;
    else post({ t: 'cmd', c: 'vol', v: v });
  }

  /* ---------- messages from other tabs ---------- */
  if (chan) chan.onmessage = function (e) {
    var m = e.data || {};
    switch (m.t) {
      case 'who':
        if (role === 'owner') announce();
        break;
      case 'state':
        if (m.id === myId) break;
        if (role === 'owner') {                    // two owners? smaller id wins
          if (m.id < myId) demote(); else break;
        }
        claimToken++;                              // somebody is in charge: drop a pending takeover
        lastState = Date.now();
        track = m.track;
        remoteView = { status: m.status, time: m.time, dur: m.dur };
        remoteQ = m.q || { name: '', i: 0, n: 0, shuf: false };
        render();
        break;
      case 'claim':
        if (m.id === myId) break;
        lastState = Date.now();
        claimToken++;                              // another tab is taking over; drop our attempt
        if (role === 'owner') {
          if (m.user) demote();                    // a real click in another tab wins
          else announce();                         // automatic takeover: tell them we are still here
        }
        break;
      case 'stopped':
        claimToken++;
        if (role === 'owner') { audio.pause(); audio.removeAttribute('src'); audio.load(); wantPlay = false; }
        role = 'remote'; track = null; queue = null; shuffled = false; remoteQ = { name: '', i: 0, n: 0, shuf: false }; render();
        break;
      case 'bye':
        if (role === 'remote' && track) takeoverSoon();
        break;
      case 'cmd':
        if (role !== 'owner' || !track) break;
        if (m.c === 'toggle') toggle();
        else if (m.c === 'stop') ownerStop();
        else if (m.c === 'seek') seek(m.v);
        else if (m.c === 'vol') audio.volume = m.v;
        else if (m.c === 'next') next();
        else if (m.c === 'prev') prev();
        break;
    }
  };

  function takeoverSoon() {
    if (role !== 'remote' || !track) return;
    var askedAt = Date.now();
    var mine = ++claimToken;
    post({ t: 'who' });                       // give a live owner the chance to answer first
    setTimeout(function () {
      if (mine !== claimToken) return;        // somebody answered / a real click happened
      if (role !== 'remote' || !track) return;
      if (lastState > askedAt) return;         // an owner spoke after we asked
      if (Date.now() - lastState < 1500) {    // it just went quiet: look again shortly
        setTimeout(function () { if (mine === claimToken) takeoverSoon(); }, 700);
        return;
      }
      claimFromSaved(true);                   // only continues a song that was playing
    }, 450 + Math.random() * 450);
  }

  // If the owner vanished without saying goodbye (crash / killed tab), take over.
  setInterval(function () {
    if (role !== 'remote' || !track || Date.now() - lastState < 2500) return;
    if (Date.now() - lastTakeoverAt < 8000) return;
    lastTakeoverAt = Date.now();
    takeoverSoon();
  }, 1000);

  // Owner heartbeat: save position + tell the other tabs
  setInterval(function () {
    if (role === 'owner' && track) { save(); announce(); }
  }, 500);

  window.addEventListener('pagehide', function () {
    if (role === 'owner' && track) {
      save();
      markOwner();                            // the next page in THIS tab may continue the song
      post({ t: 'bye', id: myId });
    }
  });

  function init() {
    role = 'remote'; track = null; lastState = 0;
    var wasOwner = wasOwnerHere();
    post({ t: 'who' });
    var tries = 0, mine = ++claimToken;
    function decide() {
      if (mine !== claimToken) { render(); return; }        // someone already spoke
      if (lastState !== 0) { render(); return; }            // a live owner answered: just listen
      tries++;
      if (tries < (wasOwner ? 1 : 4)) { post({ t: 'who' }); setTimeout(decide, 220); return; }
      var s = loadSaved();
      if (!s) { render(); return; }
      if (s.status === 'playing') {
        // Continue the song in the tab that was already playing it, or when nobody owns it.
        if (wasOwner || !savedOwnerAlive()) claimFromSaved(true);
      } else if (wasOwner) {
        claimFromSaved(false);                              // paused: show it, do not auto-play
      } else {
        adoptSaved();                                       // new tab: show it, never steal
      }
      render();
    }
    setTimeout(decide, wasOwner ? 120 : 200);
  }
  function savedOwnerAlive() { return Date.now() - lastState < 1500; }
  window.addEventListener('pageshow', function (e) { if (e.persisted) init(); });

  /* ---------- the widget (Shadow DOM so site CSS can't break it) ---------- */
  var ui = null;
  var frameOK = (window.top === window.self); // pages inside an iframe only show it if no parent does
  var dragging = false;

  if (window.top !== window.self) {
    try { window.parent.postMessage({ musica: 'hello' }, '*'); } catch (e) {}
    var decided = false;
    window.addEventListener('message', function (e) {
      if (e.data && e.data.musica === 'has-widget') { decided = true; frameOK = false; render(); }
    });
    setTimeout(function () { if (!decided) { frameOK = true; render(); } }, 300);
  }
  window.addEventListener('message', function (e) {
    if (e.data && e.data.musica === 'hello' && e.source) {
      try { e.source.postMessage({ musica: 'has-widget' }, '*'); } catch (err) {}
    }
  });

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box}' +
    '.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.3 system-ui,Arial,sans-serif;color:#fff}' +
    '.card{display:flex;gap:12px;align-items:center;width:360px;padding:10px;background:#181818;border:2px solid #1db954;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,.6)}' +
    '.cover{width:56px;height:56px;border-radius:6px;object-fit:cover;background:#222;flex:none}' +
    '.body{flex:1;min-width:0}' +
    '.title{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.artist{color:#b3b3b3;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}' +
    '.row{display:flex;align-items:center;gap:6px}' +
    '.time{font-size:11px;color:#b3b3b3;min-width:30px;text-align:center}' +
    'input[type=range]{flex:1;min-width:0;height:4px;accent-color:#1db954;margin:0;cursor:pointer}' +
    '.btns{display:flex;align-items:center;gap:6px;margin-top:6px}' +
    'button{font:700 12px system-ui,Arial,sans-serif;border:0;border-radius:5px;padding:5px 10px;cursor:pointer}' +
    '.pp{background:#1db954;color:#000;min-width:52px}' +
    '.sk{background:#333;color:#fff;padding:3px 9px;font-size:16px;line-height:1;display:none}.hasq .sk{display:inline-block}' +
    '.st{background:#e81123;color:#fff}' +
    '.mn{background:#333;color:#b3b3b3;margin-left:auto}' +
    '.vols{display:flex;gap:12px;margin-top:6px;font-size:11px;color:#b3b3b3}' +
    '.vols label{display:flex;align-items:center;gap:6px;flex:1;min-width:0}' +
    '.mini{display:none;width:46px;height:46px;border-radius:50%;background:#181818;border:2px solid #1db954;color:#1db954;font-size:20px;padding:0;box-shadow:0 4px 15px rgba(0,0,0,.6)}' +
    '.wrap.min .card{display:none}.wrap.min .mini{display:block}';

  var HTML =
    '<div class="wrap" part="wrap">' +
      '<div class="card">' +
        '<img class="cover" alt="">' +
        '<div class="body">' +
          '<div class="title"></div><div class="artist"></div>' +
          '<div class="row"><span class="time cur">0:00</span><input class="seek" type="range" min="0" max="1" step="0.1" value="0"><span class="time dur">0:00</span></div>' +
          '<div class="btns"><button class="sk pv" title="Previous">&#8249;</button><button class="pp">Pause</button><button class="sk nx" title="Next">&#8250;</button><button class="st">Stop</button>' +
          '<button class="mn" title="Minimize">&ndash;</button></div>' +
          '<div class="vols"><label>Music<input class="vol" type="range" min="0" max="1" step="0.05" title="Music volume"></label>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button class="mini" title="Show music player">&#9835;</button>' +
    '</div>';

  function buildUI() {
    if (ui || !document.documentElement) return;
    var host = document.createElement('div');
    host.id = 'musica-widget-host';
    host.style.cssText = 'all:initial;display:none';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' + HTML;
    // attach to <html> (not <body>) so body filters/transforms can't move or tint it
    document.documentElement.appendChild(host);

    var q = function (s) { return root.querySelector(s); };
    ui = {
      host: host, wrap: q('.wrap'), cover: q('.cover'), title: q('.title'), artist: q('.artist'),
      cur: q('.cur'), dur: q('.dur'), seek: q('.seek'), pp: q('.pp'), vol: q('.vol'),
      lastImg: null
    };
    ui.vol.value = getVol();
    ui.cover.onerror = function () { ui.cover.style.visibility = 'hidden'; };
    ui.cover.onload = function () { ui.cover.style.visibility = 'visible'; };

    var press = function (el, fn) {
      el.addEventListener('click', function (e) { fn(e); if (el.blur) el.blur(); });
    };
    press(ui.pp, toggle);
    press(q('.pv'), prev);
    press(q('.nx'), next);
    press(q('.st'), stop);
    press(q('.mn'), function () { setMin(true); });
    press(q('.mini'), function () { setMin(false); });

    ui.seek.addEventListener('pointerdown', function () { dragging = true; });
    ui.seek.addEventListener('input', function () { ui.cur.textContent = fmt(ui.seek.value); });
    ui.seek.addEventListener('change', function () { dragging = false; seek(parseFloat(ui.seek.value)); if (ui.seek.blur) ui.seek.blur(); });
    ui.vol.addEventListener('input', function () { setVolume(parseFloat(ui.vol.value)); });
    ui.vol.addEventListener('change', function () { if (ui.vol.blur) ui.vol.blur(); });

    setMin(sessionStorage.getItem(MIN_KEY) === '1', true);
    render();
  }

  function setMin(on, quiet) {
    try { sessionStorage.setItem(MIN_KEY, on ? '1' : '0'); } catch (e) {}
    if (ui) ui.wrap.classList.toggle('min', on);
  }

  function render() {
    if (!ui) return;
    if (!track || !frameOK) { ui.host.style.display = 'none'; return; }
    ui.host.style.display = 'block';
    var v = view();
    ui.title.textContent = track.title;
    var qi2 = qInfo();
    ui.artist.textContent = (track.artist || '') + (qi2.n > 1 ? '  \u2022  ' + (qi2.name ? qi2.name + ' ' : '') + (qi2.i + 1) + '/' + qi2.n + (qi2.shuf ? ' (shuffled)' : '') : '');
    ui.wrap.classList.toggle('hasq', qi2.n > 1);
    var imgAbs = track.img ? abs(track.img) : '';
    if (ui.lastImg !== imgAbs) { ui.lastImg = imgAbs; ui.cover.style.visibility = 'visible'; ui.cover.src = imgAbs; }
    ui.pp.textContent = v.status === 'playing' ? 'Pause' : 'Play';
    if (!dragging) {
      ui.seek.max = v.dur || 1;
      ui.seek.value = v.time;
      ui.cur.textContent = fmt(v.time);
    }
    ui.dur.textContent = fmt(v.dur);
  }

  window.Musica = {
    play: play, playQueue: playQueue, next: next, prev: prev, pause: pause, resume: resume, toggle: toggle, stop: stop,
    seek: seek, setVolume: setVolume,
    get current() { return track; },
    get status() { return view().status; },
  };


  /* ---------- tab disguise (title + icon from Settings) ----------
   * Gams.html / Settings.html / Gam.html already do this themselves. Pages without
   * their own disguise code (Music.html, the artist pages) get it from here.      */
  (function () {
    if (window !== window.top) return;                       // only the real tab matters
    function start() {
      if (typeof window.applyDisguise === 'function') return; // page handles its own disguise
      var ogTitle = document.title;
      var ogIcons = Array.prototype.slice.call(document.querySelectorAll('link[rel*="icon"]'));
      var fake = null;
      function stored(k) {
        try { var o = JSON.parse(localStorage.getItem('gams')); return (o && o[k]) || null; } catch (e) { return null; }
      }
      function apply() {
        var title = stored('title'), icon = stored('icon');
        document.title = title || ogTitle;
        if (fake) { fake.parentNode && fake.parentNode.removeChild(fake); fake = null; }
        if (icon) {                                   // disguised: swap in the disguise icon
          ogIcons.forEach(function (l) { l.parentNode && l.parentNode.removeChild(l); });
          fake = document.createElement('link');
          fake.rel = 'icon'; fake.type = 'image/x-icon'; fake.href = icon;
          document.head.appendChild(fake);
        } else {                                      // not disguised: put the page's own icon back
          ogIcons.forEach(function (l) { if (!l.parentNode) document.head.appendChild(l); });
        }
      }
      apply();
      try { new BroadcastChannel('BroadcastDisguise').onmessage = apply; } catch (e) {}
      window.addEventListener('storage', function (e) { if (e.key === 'gams') apply(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  })();

  function boot() { buildUI(); init(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();