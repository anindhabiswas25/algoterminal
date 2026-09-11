/**
 * Typecheck the TypeScript in docs/CONNECTOR_GUIDE.md against the real code.
 *
 * CONNECTOR_GUIDE.md is the spec three connectors will be built from, and its
 * §1 interface and §3 skeleton are copied verbatim by whoever writes them. Both
 * had already drifted out of compiling once — §3 called `computeConfidence`
 * with a string derivation, an invented penalty name and no `metric`, and read
 * `res.results` off an unvalidated `unknown`. A doc that only *looks* right
 * teaches its mistakes three times over, so "the guide compiles" is enforced
 * here rather than claimed in a commit message.
 *
 * Two blocks, two different checks:
 *
 *   §1 + §1.2  ->  interface.ts. Verifies the guide is internally consistent —
 *                  every type §1 references is defined, every type it imports
 *                  still exists — and that each interface it publishes still
 *                  conforms to the one src/connectors/types.ts exports.
 *   §3         ->  index.ts, compiled against the REAL src/connectors/types.ts.
 *                  Verifies a connector written by copying the skeleton would
 *                  actually satisfy the interface it will be registered under.
 *
 * Both are emitted into one scratch directory at src/connectors/<scratch>/ —
 * the depth of a real connector — so the relative imports in the doc resolve to
 * exactly the modules they will resolve to in src/connectors/<protocol>/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = join(repoRoot, 'docs/CONNECTOR_GUIDE.md');

/** Must match tsconfig.json's `exclude` and .gitignore. */
const SCRATCH_DIR = 'src/connectors/__doc_skeleton__';

/**
 * Helpers the §3 skeleton calls but does not define — it elides them as
 * uninteresting, which is the right call for a doc. Supplying them here keeps
 * the elision legal without putting noise in the guide.
 */
/**
 * Appended to the extracted §1 blocks: an assignability check in the
 * doc -> code direction for every interface §1 publishes.
 *
 * Without it, §1 is only checked for internal consistency — a field silently
 * dropped from the guide still compiles, because nothing in the extracted
 * module consumes it. With it, a guide that has drifted from
 * src/connectors/types.ts fails here instead of in the head of whoever is
 * writing connector #4 from it.
 *
 * One direction, not two, because the real types are `readonly` throughout and
 * the guide's are not: a mutable array is assignable to a readonly one but not
 * the reverse, so code -> doc would fail on a deliberate simplification rather
 * than on drift. The consequence is that a field present in the guide and
 * absent from the code is NOT caught here; a missing or mistyped one is.
 */
const INTERFACE_CONFORMANCE = `
import type * as code from '../types.js';

declare const capabilities: ConnectorCapabilities;
declare const snapshot: RawSnapshot;
declare const context: ConnectorContext;
declare const fetchOpts: FetchOpts;
declare const toFactsOpts: ToFactsOpts;
declare const connector: Connector;

export const _capabilities: code.ConnectorCapabilities = capabilities;
export const _snapshot: code.RawSnapshot = snapshot;
export const _context: code.ConnectorContext = context;
export const _fetchOpts: code.FetchOpts = fetchOpts;
export const _toFactsOpts: code.ToFactsOpts = toFactsOpts;
export const _connector: code.Connector = connector;
`;

const SKELETON_HELPERS = `
function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((n, x) => n + f(x), 0);
}
function assertClose(a: number, b: number, tolerance: number): void {
  if (Math.abs(a - b) > tolerance) {
    throw new Error(\`DATA_SCHEMA.md §3.1 identity violated: \${a} != \${b}\`);
  }
}
`;

/** Every ```ts fenced block between two headings. */
function tsBlocksBetween(markdown: string, startHeading: string, endHeading: string): string[] {
  const start = markdown.indexOf(startHeading);
  if (start === -1) throw new Error(`verify-docs: heading not found: ${startHeading}`);
  const afterStart = markdown.slice(start + startHeading.length);
  const end = afterStart.indexOf(endHeading);
  const section = end === -1 ? afterStart : afterStart.slice(0, end);
  return [...section.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((m) => m[1] as string);
}

/**
 * Rewrite the relative imports in an extracted block.
 *
 * Two adjustments, neither of which is a defect in the guide:
 *
 * - The guide writes imports without a file extension, which reads better and
 *   is how every editor autocompletes them. The project is NodeNext, which
 *   requires `.js`. Adding it here keeps the guide readable without exempting
 *   it from the compiler.
 * - Blocks are written as if they were at their real paths, and those differ:
 *   §1 is `src/connectors/types.ts`, §3 is `src/connectors/<protocol>/index.ts`,
 *   one level deeper. Everything extracted lands in one scratch directory at
 *   the §3 depth, so a §1 block's specifiers need one extra `../` to reach the
 *   same real modules.
 */
function rewriteImports(source: string, extraUp = 0): string {
  return source.replace(
    /(from\s+')(\.[^']*?)(')/g,
    (_all, pre: string, spec: string, post: string) => {
      let out = /\.[a-z]+$/.test(spec) ? spec : `${spec}.js`;
      for (let i = 0; i < extraUp; i++) {
        out = out.startsWith('./') ? `../${out.slice(2)}` : `../${out}`;
      }
      return `${pre}${out}${post}`;
    },
  );
}

function main(): void {
  const guide = readFileSync(guidePath, 'utf8');

  const interfaceBlocks = tsBlocksBetween(guide, '## 1. The interface', '## 2. ');
  const skeletonBlocks = tsBlocksBetween(guide, '## 3. Reference skeleton', '## 4. ');

  if (interfaceBlocks.length < 2) {
    throw new Error(
      `verify-docs: expected the §1 interface block and the §1.2 services block, found ${interfaceBlocks.length}. ` +
        'If §1 was restructured, update this script — do not delete the check.',
    );
  }
  if (skeletonBlocks.length !== 1) {
    throw new Error(
      `verify-docs: expected exactly one §3 skeleton block, found ${skeletonBlocks.length}.`,
    );
  }

  const scratch = join(repoRoot, SCRATCH_DIR);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  try {
    // §1 is written as src/connectors/types.ts — one level shallower than the
    // scratch directory, hence extraUp: 1.
    writeFileSync(
      join(scratch, 'interface.ts'),
      rewriteImports(interfaceBlocks.join('\n\n'), 1) + '\n' + INTERFACE_CONFORMANCE,
    );
    // §3 is written as src/connectors/<protocol>/index.ts — the scratch
    // directory's own depth, so its specifiers are already right.
    writeFileSync(
      join(scratch, 'index.ts'),
      rewriteImports(skeletonBlocks[0] as string) + '\n' + SKELETON_HELPERS,
    );

    execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.docs.json'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch {
    process.stderr.write(
      `\nThe TypeScript in docs/CONNECTOR_GUIDE.md no longer compiles against src/.\n` +
        `Fix the guide (or the code it describes) — the paths above are line numbers\n` +
        `within the extracted blocks, at ${SCRATCH_DIR}/.\n` +
        `Re-run with KEEP_DOC_SKELETON=1 to inspect the generated files.\n`,
    );
    process.exitCode = 1;
    return;
  } finally {
    if (process.env.KEEP_DOC_SKELETON !== '1') {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

main();
