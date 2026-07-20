#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "src");
const manifestSource = path.join(rootDir, "targets", "full", "manifest.json");
const distDir = path.join(rootDir, "dist");
const defaultOutputDir = path.join(distDir, "full");
const markerSuffix = ".gladiatus-full-build-owner";
const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");

function parseArguments(argv) {
  if (!argv.length) return { outputDir: defaultOutputDir };
  if (argv.length === 2 && argv[0] === "--out" && argv[1]) {
    return { outputDir: path.resolve(argv[1]) };
  }
  throw new Error("Usage: node scripts/build-full.js [--out DIRECTORY]");
}

function assertSafeOutputDirectory(value) {
  const target = path.resolve(value);
  const filesystemRoot = path.parse(target).root;
  const isRepoAncestor = target === rootDir || rootDir.startsWith(`${target}${path.sep}`);
  const isInsideRepo = target.startsWith(`${rootDir}${path.sep}`);
  const isInsideDist = target.startsWith(`${distDir}${path.sep}`);
  if (target === filesystemRoot
    || isRepoAncestor
    || (isInsideRepo && !isInsideDist)
    || target === distDir) {
    throw new Error(`Refusing to replace unsafe output directory: ${target}`);
  }
  return target;
}

function markerPath(target) {
  return `${target}${markerSuffix}`;
}

function markerValue(target) {
  return `gladiatus-full-build-v1\n${path.resolve(target)}\n`;
}

function hasBuildMarker(target) {
  try {
    return fs.readFileSync(markerPath(target), "utf8") === markerValue(target);
  } catch (_error) {
    return false;
  }
}

function hasFullManifest(target) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
    return manifest.name === "Gladiatus Helper (Unofficial)";
  } catch (_error) {
    return false;
  }
}

function listFiles(directory, prefix = "") {
  const output = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(directory, relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}

function build(options = {}) {
  const target = assertSafeOutputDirectory(options.outputDir || defaultOutputDir);
  if (!fs.statSync(manifestSource, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The full manifest source is missing.");
  }
  const sourceFiles = listFiles(sourceDir);
  if (!sourceFiles.length) throw new Error("The src directory is empty.");

  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) {
      throw new Error(`Refusing to replace a non-directory output target: ${target}`);
    }
    if (fs.readdirSync(target).length) {
      const owned = hasFullManifest(target)
        && (hasBuildMarker(target) || target === defaultOutputDir);
      if (!owned) throw new Error(`Refusing to replace a directory not owned by this build: ${target}`);
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.build-`));
  try {
    const manifestDestination = path.join(staging, "manifest.json");
    fs.copyFileSync(manifestSource, manifestDestination);
    fs.utimesSync(manifestDestination, fixedTimestamp, fixedTimestamp);
    for (const relative of sourceFiles) {
      const destination = path.join(staging, "src", relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, relative), destination);
      fs.utimesSync(destination, fixedTimestamp, fixedTimestamp);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.writeFileSync(markerPath(target), markerValue(target), "utf8");
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { outputDir: target, files: ["manifest.json", ...sourceFiles.map((file) => path.join("src", file))] };
}

if (require.main === module) {
  try {
    const result = build(parseArguments(process.argv.slice(2)));
    console.log(`Full extension: ${result.outputDir}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  rootDir,
  sourceDir,
  manifestSource,
  defaultOutputDir,
  parseArguments,
  assertSafeOutputDirectory,
  listFiles,
  build
});
