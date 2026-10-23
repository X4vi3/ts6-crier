// Build a release archive for the platform this runs on:
//   release/ts6-crier-<os>-<arch>.(zip|tar.gz)
//
// The archive is self-contained — the bot as a single executable (Node baked
// in), ffmpeg next to it, default sounds and the example config. Nothing to
// install, so it does not matter which Linux distribution it lands on.
//
// Run on each target OS (CI does it in a matrix); cross-building is not
// supported because the executable is the host's own node binary.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG_RELEASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";

const os = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform];
if (!os) throw new Error(`unsupported platform ${process.platform}`);
const arch = process.arch;
const target = `${os}-${arch}`;
const ffTarget = `${process.platform}-${arch}`;
const exe = process.platform === "win32" ? ".exe" : "";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const stage = path.join(root, "release", "ts6-crier");
fs.rmSync(path.join(root, "release"), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. One CommonJS file with every dependency inside.
run(process.execPath, ["scripts/bundle.mjs"]);

// 2. Turn it into a single executable: the host's node binary with the
//    bundle injected (https://nodejs.org/api/single-executable-applications.html).
const blob = path.join(root, "release", "sea.blob");
const seaConfig = path.join(root, "release", "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: path.join(root, "dist", "ts6-crier.cjs"),
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  })
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

const bin = path.join(stage, `ts6-crier${exe}`);
fs.copyFileSync(process.execPath, bin);
fs.chmodSync(bin, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", bin]);
run(npx, [
  "postject", bin, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
], { shell: process.platform === "win32" });
if (process.platform === "darwin") run("codesign", ["--sign", "-", bin]);

// 3. ffmpeg, a static build, so it runs on any distribution.
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const cacheDir = path.join(root, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });
const ffCached = path.join(cacheDir, `ffmpeg-${ffTarget}`);
if (!fs.existsSync(ffCached)) {
  console.log(`downloading ffmpeg for ${ffTarget}...`);
  fs.writeFileSync(ffCached, zlib.gunzipSync(await download(`${FFMPEG_RELEASE}/ffmpeg-${ffTarget}.gz`)));
}
fs.copyFileSync(ffCached, path.join(stage, `ffmpeg${exe}`));
fs.chmodSync(path.join(stage, `ffmpeg${exe}`), 0o755);
const ffLicense = await download(`${FFMPEG_RELEASE}/${ffTarget}.LICENSE`).catch(() => null);

// 4. Everything the bot reads at runtime.
fs.copyFileSync(path.join(root, "dist", "opusscript_native_wasm.wasm"), path.join(stage, "opusscript_native_wasm.wasm"));
for (const f of ["config.example.yml", "avatar.png", "README.md", "README.ru.md", "LICENSE"]) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
fs.mkdirSync(path.join(stage, "sounds"));
for (const f of fs.readdirSync(path.join(root, "sounds"))) {
  const p = path.join(root, "sounds", f);
  if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(stage, "sounds", f));
}

fs.writeFileSync(
  path.join(stage, "THIRD-PARTY-NOTICES.txt"),
  [
    "ts6-crier bundles the following third-party software.",
    "",
    "== Node.js ==  https://nodejs.org  (MIT license)",
    "The ts6-crier executable is a Node.js single-executable application.",
    "",
    "== libopus via opusscript ==  https://github.com/abalabahaha/opusscript  (MIT / BSD)",
    fs.readFileSync(path.join(root, "node_modules/opusscript/build/COPYING.libopus"), "utf-8"),
    "",
    "== libsodium ==  https://libsodium.org  (ISC license)",
    "",
    "== FFmpeg ==  https://ffmpeg.org",
    `Static build from ${FFMPEG_RELEASE}/ffmpeg-${ffTarget}.gz`,
    "Source code: https://ffmpeg.org/download.html",
    ffLicense ? ffLicense.toString("utf-8") : "",
  ].join("\n")
);

// 5. The archive itself, with a ts6-crier/ folder inside so unpacking never
//    sprays files into the current directory.
const archive = path.join(root, "release", `ts6-crier-${target}${process.platform === "win32" ? ".zip" : ".tar.gz"}`);
if (process.platform === "win32") {
  run(path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe"), ["-a", "-c", "-f", archive, "-C", path.join(root, "release"), "ts6-crier"]);
} else {
  run("tar", ["-czf", archive, "-C", path.join(root, "release"), "ts6-crier"]);
}
fs.rmSync(blob);
fs.rmSync(seaConfig);
console.log(`\n${archive} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MB)`);
