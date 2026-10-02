# KeepTrack logo

`files/` has the logo for use anywhere (signs, truck doors, cards, email). Use the SVGs when you can; they stay sharp at any size.

| File | Use |
|---|---|
| keeptrack-logo.svg / .png | Main logo, on white or light backgrounds |
| keeptrack-logo-white.svg / .png | On dark backgrounds (white letters, orange check) |
| keeptrack-logo-black.svg / .png | One color, black (black-and-white print, stamps) |
| keeptrack-logo-white-mono.svg | One color, white (on photos or colored backgrounds) |
| kt-monogram.svg / .png, kt-monogram-white.svg | The KT mark alone |
| kt-tile.svg, kt-tile-1024.png | App icon / profile picture |

Colors: near-black `#15171C`, orange `#D4500B`. Letters are Archivo at its heaviest weight, with a custom K, T and k.
Keep clear space around the logo of at least the height of the "e".

## Rebuilding

`src/` draws the logo from the Archivo font: `build.py` (the letters: K and T lanes, the k's check, the KT monogram),
`export.py` (writes the SVGs) and `pngs.mjs` (renders the PNGs and the website's icons with headless Chromium).
Put `archivo-latin-wdth-normal.woff2` (from `npm pack @fontsource-variable/archivo`) next to the scripts, then
`pip install fonttools uharfbuzz brotli shapely` and run `python3 export.py && node pngs.mjs`.
The website uses `img/keeptrack-logo.svg`, `img/keeptrack-logo-white.svg` (PDF reports) and the icons in `img/`.
