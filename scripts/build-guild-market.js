#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const defaultOutputDir = path.join(rootDir, "dist", "guild-market");
const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
const markerSuffix = ".gladiatus-guild-market-build-owner";
const files = Object.freeze([
  ["targets/guild-market/manifest.json", "manifest.json"],
  ["targets/guild-market/background.js", "background.js"],
  ["targets/guild-market/settings.js", "settings.js"],
  ["targets/guild-market/runtime.js", "runtime.js"],
  ["targets/guild-market/popup.html", "popup.html"],
  ["targets/guild-market/popup.css", "popup.css"],
  ["targets/guild-market/popup.js", "popup.js"],
  ["targets/guild-market/icon128.png", "icon128.png"],
  ["src/features/guild-market/guild-market-core.js", "guild-market-core.js"],
  ["src/features/guild-market/guild-market-content.js", "guild-market-content.js"]
]);

function parseArguments(argv) {
  const options = { outputDir: defaultOutputDir, createZip: true, zipPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      if (!argv[index + 1]) throw new Error("--out needs a directory path");
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--zip") {
      if (!argv[index + 1]) throw new Error("--zip needs a file path");
      options.zipPath = path.resolve(argv[index + 1]);
      options.createZip = true;
      index += 1;
    } else if (argument === "--no-zip") {
      options.createZip = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function assertSafeOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const filesystemRoot = path.parse(resolved).root;
  const isRepoAncestor = resolved === rootDir || rootDir.startsWith(`${resolved}${path.sep}`);
  const isInsideRepo = resolved.startsWith(`${rootDir}${path.sep}`);
  const isInsideDist = resolved.startsWith(`${distDir}${path.sep}`);
  if (resolved === filesystemRoot
    || isRepoAncestor
    || (isInsideRepo && !isInsideDist)
    || resolved === distDir) {
    throw new Error(`Refusing to replace unsafe output directory: ${resolved}`);
  }
  return resolved;
}

function markerPath(target) {
  return `${target}${markerSuffix}`;
}

function markerValue(kind, target) {
  return `gladiatus-guild-market-build-v1\n${kind}\n${path.resolve(target)}\n`;
}

function hasBuildMarker(kind, target) {
  try {
    return fs.readFileSync(markerPath(target), "utf8") === markerValue(kind, target);
  } catch (_error) {
    return false;
  }
}

function writeBuildMarker(kind, target) {
  fs.writeFileSync(markerPath(target), markerValue(kind, target), "utf8");
}

function hasProductManifest(target) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
    return manifest.name === "Gladiatus Guild Market Helper (Unofficial)";
  } catch (_error) {
    return false;
  }
}

function assertSourcesReady() {
  const destinations = new Set();
  for (const [sourceName, destinationName] of files) {
    const source = path.join(rootDir, sourceName);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Release source is missing: ${sourceName}`);
    }
    if (destinations.has(destinationName)) throw new Error(`Duplicate release destination: ${destinationName}`);
    destinations.add(destinationName);
  }
}

function copyReleaseFiles(outputDir) {
  const target = assertSafeOutputDirectory(outputDir);
  assertSourcesReady();
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) {
      throw new Error(`Refusing to replace a non-directory output target: ${target}`);
    }
    const entries = fs.readdirSync(target);
    if (entries.length) {
      const owned = hasProductManifest(target)
        && (hasBuildMarker("directory", target) || target === defaultOutputDir);
      if (!owned) throw new Error(`Refusing to replace a directory not owned by this build: ${target}`);
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.build-`));
  try {
    for (const [sourceName, destinationName] of files) {
      const source = path.join(rootDir, sourceName);
      const destination = path.join(staging, destinationName);
      fs.copyFileSync(source, destination);
      fs.utimesSync(destination, fixedTimestamp, fixedTimestamp);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    writeBuildMarker("directory", target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

function defaultZipPath(outputDir, version) {
  return path.join(path.dirname(outputDir), `gladiatus-guild-market-${version}.zip`);
}

function createReleaseZip(outputDir, requestedPath = "") {
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
  const zipPath = path.resolve(requestedPath || defaultZipPath(outputDir, manifest.version));
  const canonicalRepoZip = path.resolve(defaultZipPath(defaultOutputDir, manifest.version));
  if (zipPath === path.parse(zipPath).root) throw new Error("Refusing to replace an unsafe ZIP path");
  if (path.extname(zipPath).toLocaleLowerCase("en-US") !== ".zip") {
    throw new Error("The release archive path must end in .zip");
  }
  const zipInsideRepo = zipPath.startsWith(`${rootDir}${path.sep}`);
  const zipInsideDist = zipPath.startsWith(`${distDir}${path.sep}`);
  if (zipInsideRepo && !zipInsideDist) {
    throw new Error(`Refusing to replace an archive inside the source tree: ${zipPath}`);
  }
  if (zipPath === outputDir || zipPath.startsWith(`${outputDir}${path.sep}`)) {
    throw new Error("The release ZIP must be outside the unpacked extension directory");
  }
  if (fs.existsSync(zipPath)) {
    if (!fs.statSync(zipPath).isFile()) throw new Error(`Refusing to replace a non-file ZIP target: ${zipPath}`);
    if (!hasBuildMarker("zip", zipPath) && zipPath !== canonicalRepoZip) {
      throw new Error(`Refusing to replace a ZIP not owned by this build: ${zipPath}`);
    }
  }
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(zipPath), ".guild-market-zip-"));
  const stagingZip = path.join(stagingDir, path.basename(zipPath));
  try {
    childProcess.execFileSync("zip", [
      "-X",
      "-q",
      stagingZip,
      ...files.map((entry) => entry[1]).sort()
    ], { cwd: outputDir, stdio: "pipe", env: { ...process.env, TZ: "UTC" } });
    fs.rmSync(zipPath, { force: true });
    fs.renameSync(stagingZip, zipPath);
    writeBuildMarker("zip", zipPath);
  } catch (error) {
    throw new Error(`Could not create the release ZIP. Install the standard zip command or run with --no-zip. ${error.message}`);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  return zipPath;
}

function build(options = {}) {
  const outputDir = copyReleaseFiles(options.outputDir || defaultOutputDir);
  const zipPath = options.createZip === false
    ? ""
    : createReleaseZip(outputDir, options.zipPath || "");
  return { outputDir, zipPath, files: files.map((entry) => entry[1]) };
}

if (require.main === module) {
  try {
    const result = build(parseArguments(process.argv.slice(2)));
    console.log(`Guild Market extension: ${result.outputDir}`);
    if (result.zipPath) console.log(`Release ZIP: ${result.zipPath}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  files,
  parseArguments,
  assertSafeOutputDirectory,
  copyReleaseFiles,
  createReleaseZip,
  build
});
