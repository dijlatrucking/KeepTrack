// Renders the exported SVGs to PNGs at exact pixel sizes (transparent where the SVG is).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const jobs = [
  ["_tile-16.svg", "favicon-16.png", 16, 16],
  ["_tile-32.svg", "favicon-32.png", 32, 32],
  ["_tile-32.svg", "favicon-48.png", 48, 48],
  ["_tile-square.svg", "apple-touch-icon.png", 180, 180],
  ["kt-tile.svg", "icon-192.png", 192, 192],
  ["kt-tile.svg", "icon-512.png", 512, 512],
  ["_tile-maskable.svg", "icon-maskable-512.png", 512, 512],
  ["kt-tile.svg", "kt-tile-1024.png", 1024, 1024],
  ["keeptrack-logo.svg", "keeptrack-logo.png", 2400, 0],
  ["keeptrack-logo-white.svg", "keeptrack-logo-white.png", 2400, 0],
  ["keeptrack-logo-black.svg", "keeptrack-logo-black.png", 2400, 0],
  ["kt-monogram.svg", "kt-monogram.png", 1200, 0],
];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const page = await browser.newPage({ viewport: { width: 2600, height: 2600 }, deviceScaleFactor: 1 });
for (const [src, out, w, h0] of jobs) {
  let svg = readFileSync("out/" + src, "utf8");
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const h = h0 || Math.round(w * +vb[2] / +vb[1]);
  svg = svg.replace(/ width="[\d.]+" height="[\d.]+"/, ` width="${w}" height="${h}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div id="x" style="width:${w}px;height:${h}px;line-height:0">${svg}</div></body></html>`);
  await page.locator("#x").screenshot({ path: "out/" + out, omitBackground: true });
  console.log(out, w + "x" + h);
}
await browser.close();
