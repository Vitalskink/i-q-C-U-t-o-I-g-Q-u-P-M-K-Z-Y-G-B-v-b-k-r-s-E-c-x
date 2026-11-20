Friday Night Funkin' - folder build

This is the same V-Slice build as before, but the assets live here as normal
files instead of being baked into one giant HTML file.

ADDING MODS
  Put a V-Slice mod folder (or a mod .zip) inside this mods/ folder, then
  refresh the game. Mod folders must contain _polymod_meta.json at their top
  level and must be built for modding API >=0.8.0 <0.9.0.
  Psych Engine mods (pack.json / weeks/) are NOT V-Slice mods and will not load.

  If the local converter server has not been updated yet, mods.zip is served
  as a static file, so after adding a mod run PACK-MODS.bat once (or:
  node <fridaynightfunkin folder>\make-fnf-folder.js --repack).

WHAT IS PATCHED (baked into Funkin.js)
  - song length + song end (songs used to restart themselves / never finish)
  - mod asset typing and asset paths (mods' songs/characters/scripts appear)
  - Array.insert/remove/contains/copy/resize (mod JSON _merge files)
  - mod image preloading and .ogg audio used for .mp3 requests
  - gams-boot.js keeps the loader running when the tab is in the background
