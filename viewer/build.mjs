#!/usr/bin/env node
/**
 * Inline every module into a single self-contained page.
 *
 * The shipped page must work from a file:// URL and as a published Artifact,
 * where a strict CSP blocks any external fetch -- so it cannot use ES module
 * imports that resolve over the network.
 *
 * Modules are wrapped in IIFEs rather than concatenated. Concatenation shares
 * one scope, so two modules that both define `PAGE_SIZE` collide and the whole
 * script fails to parse -- silently, because nothing on the page runs to report
 * it. Each module now keeps its own scope and publishes only what it exports.
 *
 * The result is syntax-checked before it is written. A bundler that cannot
 * produce a parsable file must fail the build, not ship one.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));

/** Dependencies first: a module's IIFE runs before anything that imports it. */
const order = [
  'sqlcipher.js', 'sqlite.js', 'sqlite_write.js', 'pdb.js', 'anlz.js',
  'devicefiles.js', 'envelope.js',
  'waveform.js', 'player.js', 'midi.js', 'deck.js', 'editor.js', 'validate.js',
  'app.js',
];

const nsOf = (name) => '__' + name.replace(/\W/g, '_');

const EXPORT_DECL = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const IMPORT_LINE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$/gm;

function transform(name, source) {
  const exports = [...source.matchAll(EXPORT_DECL)].map((m) => m[1]);
  if (!exports.length && name !== 'app.js') {
    throw new Error(`${name} exports nothing — check the export syntax`);
  }

  let body = source.replace(IMPORT_LINE, (_all, names, from) => {
    const file = from.replace(/^\.\//, '');
    if (!order.includes(file)) throw new Error(`${name} imports unknown module ${from}`);
    const wanted = names.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    return `const { ${wanted} } = ${nsOf(file)};`;
  });
  body = body.replace(/^export\s+(?=(async|const|let|var|function|class)\b)/gm, '');

  return `const ${nsOf(name)} = (() => {\n${body}\nreturn { ${exports.join(', ')} };\n})();`;
}

const modules = order.map((name) =>
  transform(name, readFileSync(join(root, 'src', name), 'utf8'))
);
const script = `${modules.join('\n')}\n${nsOf('app.js')}.init();`;

// Fail loudly rather than shipping a page whose script never runs.
try {
  new Function(script);
} catch (err) {
  console.error(`\nBUILD FAILED — bundled script does not parse:\n  ${err.message}\n`);
  process.exit(1);
}

/**
 * Inline a linked stylesheet, for the same reason the modules are inlined: the
 * shipped page has to work from file:// and as an Artifact, where a strict CSP
 * blocks any external fetch. Served unbuilt, the <link> resolves normally, so
 * development and the build see the same styles.
 */
function inlineStyles(html) {
  return html.replace(
    /[ \t]*<link rel="stylesheet" href="([^"]+)">\n?/g,
    (_all, href) => {
      const css = readFileSync(join(root, href), 'utf8');
      return `<style>\n/* ${href} */\n${css}</style>\n`;
    }
  );
}

const html = inlineStyles(
  readFileSync(join(root, 'index.html'), 'utf8').replace(
    /<script type="module">[\s\S]*?<\/script>/,
    `<script type="module">\n${script}\n</script>`
  )
);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html    ${(html.length / 1024).toFixed(1)} KB`);

// Artifact variant: the host supplies the document skeleton.
const artifact = html
  .replace(/^<!doctype html>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
writeFileSync(join(root, 'dist', 'artifact.html'), artifact);
console.log(`dist/artifact.html ${(artifact.length / 1024).toFixed(1)} KB`);

// The sample library the page offers when a visitor has no device of their own.
// It is fetched at a path relative to the page, so it has to sit beside the
// built page rather than beside the source -- dist/ is what gets deployed, and
// a page that offers a sample and then 404s is worse than not offering one.
if (existsSync(join(root, 'sample'))) {
  cpSync(join(root, 'sample'), join(root, 'dist', 'sample'), { recursive: true });
  console.log('dist/sample/        copied');
}
