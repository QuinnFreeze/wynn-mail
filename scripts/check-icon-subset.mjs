import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cssPath = join(root, 'src/lib/styles/remixicon.css');
const fontPath = join(root, 'src/lib/assets/remixicon-subset.woff');
const upstream = readFileSync(join(root, 'node_modules/remixicon/fonts/remixicon.css'), 'utf8');
const glyphs = new Map([...upstream.matchAll(/\.ri-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([a-f0-9]+)";\s*\}/g)]
 .map((match) => [match[1], match[2]]));
const words = new Set();
/** @param {string} directory */
function scan(directory) {
 for (const entry of readdirSync(directory, { withFileTypes: true })) {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) scan(path);
  else if (/\.(svelte|ts|js|css)$/.test(entry.name) && path !== cssPath && !/\.test\./.test(entry.name)) {
   for (const match of readFileSync(path, 'utf8').matchAll(/\b(?:ri-)?([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)) words.add(match[1]);
  }
 }
}
scan(join(root, 'src'));
const names = [...glyphs.keys()].filter((name) => words.has(name)).sort();
if (!names.length) throw new Error('No interface icons found');
if (process.argv.includes('--metadata')) {
 console.log(JSON.stringify({ names, codepoints: names.map((name) => parseInt(glyphs.get(name) ?? '', 16)), fontPath }));
} else {
 if (!existsSync(fontPath)) throw new Error('Regenerate icons: python3 scripts/build-icon-subset.py');
 const sha = createHash('sha256').update(readFileSync(fontPath)).digest('hex');
 const css = `/* Remix Icon v4.9.1, Copyright (c) 2017–2026 Remix Design.\n * Application-only subset; glyphs are unmodified. Remix Icon License v1.0.\n * See licenses/Remix-Icon-License-v1.0.txt and scripts/build-icon-subset.py.\n * Font SHA256: ${sha}\n */\n@font-face {\n font-family: 'remixicon';\n src: url('../assets/remixicon-subset.woff') format('woff');\n font-display: swap;\n}\n[class^='ri-'], [class*=' ri-'] {\n font-family: 'remixicon' !important;\n font-style: normal;\n -webkit-font-smoothing: antialiased;\n -moz-osx-font-smoothing: grayscale;\n}\n` + names.map((name) => `.ri-${name}:before { content: "\\${glyphs.get(name)}"; }`).join('\n') + '\n';
 if (process.argv.includes('--write-css')) writeFileSync(cssPath, css);
 else if (!existsSync(cssPath) || readFileSync(cssPath, 'utf8') !== css) {
  throw new Error('Icon usage changed. Regenerate the checked-in subset with: python3 scripts/build-icon-subset.py');
 }
 console.log(`${names.length} interface glyphs verified in ${relative(root, fontPath)}`);
}
