/*
 * playlist-engine.js  -  playlists for Gams music
 *
 * Load it AFTER musica.js:
 *     <script src="../musica.js"></script>
 *     <script src="../playlist-engine.js"></script>      (pages inside m/<Artist>/)
 *     <script src="m/playlist-engine.js"></script>       (Music.html in the root)
 *
 * Storage: localStorage ("musica_playlists"), saved in this browser. Use Export /
 * Import (Music.html -> Playlists) to back them up or move them to another device.
 *
 * Songs are stored as paths from the ROOT Gams folder, like "m/Eminem/Rap_God.mp3".
 */
(function () {
  'use strict';
  if (window.Playlists) return;

  var SCRIPT = document.currentScript;
  var ROOT = (window.CG && window.CG.root) || new URL('../', SCRIPT && SCRIPT.src ? SCRIPT.src : location.href).href;   // CG.root = single-file build
  var KEY = 'musica_playlists';

  function abs(p) {
    if (!p) return '';
    if (/^(https?:|data:|blob:|file:)/i.test(p)) return p;
    return new URL(p, ROOT).href;
  }
  var PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a2a2a"/>' +
    '<text x="50" y="68" font-size="56" text-anchor="middle" fill="#1db954" font-family="Arial">&#9835;</text></svg>');

  /* ---------------- local store ---------------- */
  function readStore() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.list)) { s.deleted = s.deleted || {}; return s; }
    } catch (e) {}
    return { list: [], deleted: {} };
  }
  function writeStore(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
  }
  var listeners = [];
  function notify() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  window.addEventListener('storage', function (e) { if (e.key === KEY) notify(); });

  function lc(n) { return String(n).trim().toLowerCase(); }
  function fileBase(name) {
    var b = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
    return b || ('playlist_' + Date.now());
  }
  function cleanSong(t) {
    return { src: t.src, title: t.title || 'Unknown', artist: t.artist || '', img: t.img || '' };
  }
  function find(s, name) { return s.list.filter(function (p) { return lc(p.name) === lc(name); })[0]; }

  function list() { return readStore().list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }); }
  function get(name) { return find(readStore(), name) || null; }

  function create(name, cover, songs) {
    name = String(name || '').trim();
    if (!name) throw new Error('Please give the playlist a name.');
    var s = readStore();
    var clash = s.list.some(function (p) { return lc(p.name) === lc(name) || fileBase(p.name) === fileBase(name); });
    if (clash) throw new Error('A playlist with that name already exists.');
    var pl = { name: name, cover: cover || null, songs: (songs || []).map(cleanSong), updated: Date.now() };
    s.list.push(pl);
    if (!writeStore(s)) throw new Error('Could not save (browser storage is full). Try a smaller cover image.');
    notify();
    return pl;
  }
  function addSong(name, song) {
    var s = readStore(), pl = find(s, name);
    if (!pl) throw new Error('Playlist not found.');
    if (pl.songs.some(function (x) { return x.src === song.src; })) return false;
    pl.songs.push(cleanSong(song));
    pl.updated = Date.now();
    writeStore(s); notify();
    return true;
  }
  function removeSong(name, index) {
    var s = readStore(), pl = find(s, name);
    if (!pl) return;
    pl.songs.splice(index, 1);
    pl.updated = Date.now();
    writeStore(s); notify();
  }
  function remove(name) {
    var s = readStore(), pl = find(s, name);
    if (!pl) return;
    s.list.splice(s.list.indexOf(pl), 1);
    writeStore(s); notify();
  }
  // Rename and/or change the cover. changes.name: new name; changes.cover: data URL = new image, null = go back to the first song's picture, leave out = keep.
  function update(oldName, changes) {
    var s = readStore(), pl = find(s, oldName);
    if (!pl) throw new Error('Playlist not found.');
    if (changes.name !== undefined) {
      var nn = String(changes.name).trim();
      if (!nn) throw new Error('Please give the playlist a name.');
      if (s.list.some(function (p) { return p !== pl && lc(p.name) === lc(nn); })) throw new Error('A playlist with that name already exists.');
      pl.name = nn;
    }
    if (changes.cover !== undefined) pl.cover = changes.cover || null;
    pl.updated = Date.now();
    if (!writeStore(s)) throw new Error('Could not save (browser storage is full). Try a smaller cover image.');
    notify();
    return pl;
  }
  function coverFor(pl) {
    if (pl.cover) return pl.cover;
    if (pl.songs && pl.songs[0] && pl.songs[0].img) return abs(pl.songs[0].img);
    return PLACEHOLDER;
  }
  function onChange(fn) { listeners.push(fn); }

  /* ---------------- cover image: resize to a small square PNG ---------------- */
  function processCover(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('Could not read that image.')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('That file is not a valid image.')); };
        img.onload = function () {
          var n = 300, c = document.createElement('canvas'); c.width = c.height = n;
          var side = Math.min(img.width, img.height);
          c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, n, n);
          resolve(c.toDataURL('image/png'));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  /* ---------------- export / import (works in every browser) ---------------- */
  function exportAll() {
    var data = { format: 'gams-playlists', version: 1, playlists: list() };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'Gams_playlists.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  async function importFiles(files) {
    var s = readStore(), n = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var d = JSON.parse(await files[i].text());
        var arr = d && d.format === 'gams-playlists' ? d.playlists : (d && d.name && d.songs ? [d] : []);
        arr.forEach(function (pl) {
          if (!pl.name || !Array.isArray(pl.songs)) return;
          var np = { name: pl.name, cover: (pl.cover && /^data:/.test(pl.cover)) ? pl.cover : null,
                     songs: pl.songs.map(cleanSong), updated: pl.updated || Date.now() };
          var ex = find(s, pl.name);
          if (!ex) { s.list.push(np); n++; }
          else if (np.updated > ex.updated) { np.cover = np.cover || ex.cover; s.list[s.list.indexOf(ex)] = np; n++; }
        });
      } catch (e) {}
    }
    if (n) { writeStore(s); notify(); }
    return n;
  }

  /* ---------------- "Add to playlist" / "Create Playlist" windows ---------------- */
  var DCSS =
    ':host{all:initial}*{box-sizing:border-box}' +
    '.ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;font:14px/1.4 system-ui,Arial,sans-serif;color:#fff}' +
    '.box{background:#181818;border:2px solid #1db954;border-radius:12px;width:100%;max-width:460px;max-height:90vh;display:flex;flex-direction:column;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.7)}' +
    '.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}' +
    'h2{margin:0;font-size:17px;font-weight:700}' +
    '.sub{color:#b3b3b3;font-size:12px;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    'button{font:700 13px system-ui,Arial,sans-serif;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;background:#333;color:#fff}' +
    'button:hover{filter:brightness(1.15)}' +
    '.pri{background:#1db954;color:#000;white-space:nowrap;flex:none}' +
    '.list{overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:60px;margin-bottom:10px}' +
    '.item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#202020;padding:8px 10px}' +
    '.item:hover{background:#2c2c2c}' +
    '.item img{width:42px;height:42px;border-radius:5px;object-fit:cover;background:#333;flex:none}' +
    '.item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.item .ct{color:#b3b3b3;font-weight:400;font-size:12px}' +
    '.item .ck{color:#1db954}' +
    '.empty{color:#b3b3b3;text-align:center;padding:18px 6px}' +
    '.ft{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}' +
    '.msg{min-height:20px;font-size:13px;color:#1db954;margin:4px 0}.msg.err{color:#ff6b6b}' +
    'label{display:block;font-weight:700;margin:12px 0 5px}' +
    'label small{font-weight:400;color:#b3b3b3}' +
    'input[type=text]{width:100%;padding:9px 10px;border-radius:6px;border:1px solid #444;background:#0f0f0f;color:#fff;font:14px system-ui,Arial,sans-serif}' +
    'input[type=text]:focus{outline:2px solid #1db954;border-color:transparent}' +
    'input[type=file]{color:#b3b3b3;font-size:13px;max-width:100%}' +
    '.prev{width:72px;height:72px;border-radius:6px;object-fit:cover;margin-top:8px;display:none}';

  function openAddDialog(song) {
    song = cleanSong(song);
    var host = document.createElement('div');
    host.style.cssText = 'all:initial';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + DCSS + '</style><div class="ov"><div class="box" role="dialog" aria-modal="true"></div></div>';
    document.documentElement.appendChild(host);
    var ov = root.querySelector('.ov'), box = root.querySelector('.box');

    function close() { host.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function q(sel) { return box.querySelector(sel); }
    function msg(t, err) { var m = q('.msg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); }

    function showPick() {
      var pls = list();
      box.innerHTML =
        '<div class="hd"><h2>Select a playlist to add this song to</h2><button class="pri" data-a="new">Create playlist</button></div>' +
        '<div class="sub">' + esc(song.title) + (song.artist ? ' \u2014 ' + esc(song.artist) : '') + '</div>' +
        '<div class="list"></div><div class="msg"></div><div class="ft"><button data-a="close">Close</button></div>';
      var L = q('.list');
      if (!pls.length) L.innerHTML = '<div class="empty">You don\u2019t have any playlists yet.<br>Click \u201CCreate playlist\u201D to make your first one.</div>';
      pls.forEach(function (pl) {
        var has = pl.songs.some(function (x) { return x.src === song.src; });
        var b = document.createElement('button'); b.className = 'item';
        b.innerHTML = '<img alt=""><span class="nm">' + esc(pl.name) + '<br><span class="ct">' + pl.songs.length +
          (pl.songs.length === 1 ? ' song' : ' songs') + '</span></span>' + (has ? '<span class="ck">\u2713 Added</span>' : '');
        var im = b.querySelector('img'); im.src = coverFor(pl); im.onerror = function () { im.onerror = null; im.src = PLACEHOLDER; };
        b.onclick = function () {
          try {
            var added = addSong(pl.name, song);
            msg(added ? 'Added to \u201C' + pl.name + '\u201D \u2713' : 'That song is already in \u201C' + pl.name + '\u201D.', !added);
            if (added) setTimeout(close, 800);
          } catch (e) { msg(e.message, true); }
        };
        L.appendChild(b);
      });
      q('[data-a=new]').onclick = showCreate;
      q('[data-a=close]').onclick = close;
    }

    function showCreate() {
      box.innerHTML =
        '<div class="hd"><h2>Create Playlist</h2></div>' +
        '<div class="sub">' + esc(song.title) + ' will be added to it</div>' +
        '<label for="pn">Playlist name <small>(required)</small></label><input type="text" id="pn" maxlength="60" autocomplete="off">' +
        '<label for="pc">Cover image <small>(optional \u2013 PNG. If you skip it, the first song\u2019s picture is used)</small></label>' +
        '<input type="file" id="pc" accept="image/png,image/*"><img class="prev" alt="">' +
        '<div class="msg"></div><div class="ft"><button data-a="back">Back</button><button class="pri" data-a="make">Create</button></div>';
      var nameIn = q('#pn'), fileIn = q('#pc'), prev = q('.prev');
      setTimeout(function () { nameIn.focus(); }, 30);
      fileIn.onchange = function () {
        var f = fileIn.files[0];
        if (!f) { prev.style.display = 'none'; return; }
        prev.src = URL.createObjectURL(f); prev.style.display = 'block';
      };
      q('[data-a=back]').onclick = showPick;
      var busy = false;
      function make() {
        if (busy) return;
        var name = nameIn.value.trim();
        if (!name) { msg('Please give the playlist a name.', true); nameIn.focus(); return; }
        busy = true;
        var f = fileIn.files[0];
        (f ? processCover(f) : Promise.resolve(null)).then(function (cover) {
          create(name, cover, [song]);
          msg('Created \u201C' + name + '\u201D and added the song \u2713');
          setTimeout(close, 900);
        }).catch(function (e) { msg(e.message, true); busy = false; });
      }
      q('[data-a=make]').onclick = make;
      nameIn.onkeydown = function (e) { if (e.key === 'Enter') make(); };
    }

    showPick();
  }

  /* ---------------- "Play in order" / "Play shuffled" on every artist page ----------------
   * Artist pages define a trackConfig (artistName, folder, tracks). We add two buttons under the artist name that play
   * the artist's whole list, so there is no need to make a playlist with all of an artist's songs.            */
  function addArtistButtons() {
    try {
      if (typeof trackConfig === 'undefined' || !trackConfig || !trackConfig.tracks || !window.Musica) return;
      var title = document.getElementById('artistTitleName');
      if (!title || document.getElementById('cg-artist-play')) return;
      var folder = trackConfig.folder || trackConfig.artistName;
      function songs() {
        return trackConfig.tracks.map(function (t) {
          var dot = t.href.lastIndexOf('.'), base = dot >= 0 ? t.href.slice(0, dot) : t.href;
          var cover = (t.img && t.img !== '') ? t.img : base + '.png';
          return { src: 'm/' + folder + '/' + t.href, title: String(t.name).trim(), artist: trackConfig.artistName, img: 'm/' + folder + '/' + cover };
        });
      }
      var row = document.createElement('div');
      row.id = 'cg-artist-play';
      row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:14px';
      function btn(label, cls, shuffle) {
        var b = document.createElement('button');
        b.className = cls; b.textContent = label; b.style.fontSize = '0.95rem';
        b.onclick = function () { window.Musica.playQueue(songs(), { name: trackConfig.artistName, shuffle: shuffle }); };
        return b;
      }
      row.appendChild(btn('\u25B6  Play in order', 'play-trigger-btn', false));
      row.appendChild(btn('\uD83D\uDD00  Play shuffled', 'add-pl-btn', true));
      (title.parentNode || document.body).appendChild(row);
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addArtistButtons); else addArtistButtons();

  window.Playlists = {
    list: list, get: get, create: create, update: update, addSong: addSong, removeSong: removeSong, remove: remove,
    coverFor: coverFor, placeholder: PLACEHOLDER, onChange: onChange, processCover: processCover,
    openAddDialog: openAddDialog, exportAll: exportAll, importFiles: importFiles
  };

})();
