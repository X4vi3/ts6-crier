// Bundle the bot and its dependencies into one CommonJS file, the input a
// Node single-executable needs. Also runnable as is: node dist/ts6-crier.cjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const version = process.env.CRIER_VERSION || pkg.version;

await build({
  entryPoints: [path.join(root, "src/crier.ts")],
  outfile: path.join(root, "dist/ts6-crier.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  define: { __CRIER_VERSION__: JSON.stringify(version) },
  // identity-worker is only used by tslib's async generator, which the bot
  // never calls; import.meta there is dead code in a CommonJS bundle.
  logOverride: { "empty-import-meta": "silent" },
  legalComments: "none",
});

// opusscript loads its WebAssembly from the directory the code runs from:
// dist/ for the bundle, the executable's folder for a packaged build.
fs.copyFileSync(
  path.join(root, "node_modules/opusscript/build/opusscript_native_wasm.wasm"),
  path.join(root, "dist/opusscript_native_wasm.wasm")
);

console.log(`bundled ts6-crier ${version} -> dist/ts6-crier.cjs`);
