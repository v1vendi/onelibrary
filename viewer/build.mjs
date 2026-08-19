#!/usr/bin/env node
/**
 * Inline every module into a single self-contained dist/index.html.
 *
 * The viewer is meant to work from a file:// URL and to publish as an
 * Artifact, where a strict CSP blocks any external fetch -- so the shipped
 * page cannot use ES module imports that resolve over the network.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const order = ['sqlcipher.js', 'sqlite.js', 'anlz.js', 'waveform.js', 'app.js'];

const modules = order.map((name) => {
  const src = readFileSync(join(root, 'src', name), 'utf8');
  return src
    .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '')   // drop intra-bundle imports
    .replace(/^export\s+(?=(async|const|function|class|let|var))/gm, '');
});

const html = readFileSync(join(root, 'index.html'), 'utf8').replace(
  /<script type="module">[\s\S]*?<\/script>/,
  `<script type="module">\n${modules.join('\n')}\ninit();\n</script>`
);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html   ${(html.length / 1024).toFixed(1)} KB`);

// Artifact variant: the host supplies the document skeleton, so strip the
// doctype and the meta tags it already provides, keeping <title> for the tab.
const artifact = html
  .replace(/^<!doctype html>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
writeFileSync(join(root, 'dist', 'artifact.html'), artifact);
console.log(`dist/artifact.html ${(artifact.length / 1024).toFixed(1)} KB`);
