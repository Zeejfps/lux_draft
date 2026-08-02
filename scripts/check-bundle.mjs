#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The phase-5 bundle check (docs/plans/studio-modularization.md).
 *
 * Invariant 7 — "codecs and command handlers load eagerly; rendering and UI runtimes load
 * lazily" — is the thing that reconciles lazy modules with synchronous persistence, and it is
 * not enforceable by lint: the boundary rules stop a *codec* reaching a runtime, but nothing
 * stops the shell importing a module's stores and pulling the whole graph back in eagerly.
 * That is exactly what happened by the end of phase 4. So it is asserted against the build.
 *
 * Mechanism: `build.manifest` gives every emitted chunk with its **static** `imports` and its
 * `dynamicImports` listed separately. Walking `imports` transitively from the entry gives the
 * set of files a browser must fetch before it can render — the initial chunk set. Everything
 * behind a dynamic import is, by construction, not in it.
 *
 * The markers are string *contents* rather than symbol names: chunks are minified and
 * identifiers are mangled, but string bodies survive. They are matched without surrounding
 * quotes because the minifier rewrites quoting (it emits backticks).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');

/** Must NOT appear in any chunk the browser loads before first render. */
const FORBIDDEN = [
  {
    what: 'the IES parser',
    markers: ['TILT=', 'Invalid IES file'],
    why: 'IESParser is reachable only from the lighting definition manager, a module surface.',
  },
  {
    what: 'the heatmap shader',
    markers: ['uLightBeamAngles', 'MAX_OBSTACLE_VERTICES'],
    why: 'GLSL is imported ?raw by HeatmapRenderer, which lives behind loadRuntime().',
  },
  {
    what: 'the shadow shader',
    markers: ['uLightPosition', 'uPolygonVertices[64]'],
    why: 'Same: a lighting renderer, and renderers are the lazy half.',
  },
  {
    what: "flooring's scene layers",
    markers: ['flooring.planks', 'flooring.transitions'],
    why: 'Layer ids exist only in flooring/layers.ts, which pulls in THREE and the engine.',
  },
  {
    what: "flooring's panels",
    markers: ['boards to buy', 'Floor Layout', 'Trim a doorway'],
    why: 'Module surfaces and tools arrive through the manifest, not a shell import.',
  },
];

/** Must appear: persistence is synchronous and cannot wait for an import(). */
const REQUIRED = [
  {
    what: "lighting's codec",
    markers: ['lighting slice must be an object', 'lighting data was written at'],
    why: 'decodeDocument resolves a slice by module id without loading any runtime.',
  },
  {
    what: "lighting's command table",
    markers: ['fixture.move', 'rafterConfig.set'],
    why: 'An undo arriving mid-mode-switch must dispatch before the runtime resolves.',
  },
  {
    what: 'the document codec',
    markers: ['quarantin', 'geometryChangedSinceLoad'],
    why: 'Every entry point decodes through it, synchronously (invariant 9).',
  },
  {
    what: "flooring's codec",
    markers: ['flooring slice must be an object', 'flooring data was written at'],
    why: 'Same reason as lighting: a slice is resolved by module id with no runtime loaded.',
  },
  {
    what: "flooring's command table",
    markers: ['layout.configure', 'origin.move'],
    why: 'An undo of a layout change must dispatch before the runtime resolves.',
  },
];

function build() {
  console.log('dist/.vite/manifest.json is missing — building first.');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

if (!existsSync(manifestPath)) build();

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/** Everything statically reachable from the entry: what the browser fetches to render. */
function initialChunks() {
  const entries = Object.values(manifest).filter((chunk) => chunk.isEntry);
  if (entries.length === 0) {
    throw new Error('No entry chunk in the manifest.');
  }
  const seen = new Set();
  const queue = entries.map((chunk) => chunk.file);
  const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = byFile.get(file);
    // `imports` are static; `dynamicImports` are deliberately not followed — that is the whole
    // distinction being asserted.
    for (const key of chunk?.imports ?? []) {
      const imported = manifest[key];
      if (imported) queue.push(imported.file);
    }
  }
  return [...seen].filter((file) => file.endsWith('.js'));
}

const files = initialChunks();
const source = files.map((file) => readFileSync(join(dist, file), 'utf-8')).join('\n');

console.log(`Initial chunk set (${files.length} file${files.length === 1 ? '' : 's'}):`);
for (const file of files) console.log(`  ${file}`);
console.log('');

const failures = [];

for (const { what, markers, why } of FORBIDDEN) {
  const found = markers.filter((marker) => source.includes(marker));
  if (found.length > 0) {
    failures.push(
      `${what} IS in the initial chunk (matched ${found.map((m) => JSON.stringify(m)).join(', ')}).\n` +
        `    ${why}\n` +
        `    Something in src/app/ or src/floorplan/ imports it statically. Find it with:\n` +
        `      npx vite build --mode production && grep -rn "<the marker>" dist/assets/*.js`
    );
  } else {
    console.log(`ok    ${what} is absent from the initial chunk`);
  }
}

for (const { what, markers, why } of REQUIRED) {
  const found = markers.filter((marker) => source.includes(marker));
  if (found.length === 0) {
    failures.push(
      `${what} is MISSING from the initial chunk (none of ` +
        `${markers.map((m) => JSON.stringify(m)).join(', ')} matched).\n` +
        `    ${why}\n` +
        `    Either it became lazy, or the marker string changed and this check needs updating.`
    );
  } else {
    console.log(`ok    ${what} is present in the initial chunk`);
  }
}

if (failures.length > 0) {
  console.error('\nBundle check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log('\nBundle check passed.');
