const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const buildTool = require("../scripts/build-full.js");
const rootDir = path.resolve(__dirname, "..");

function recursiveFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function manifestFiles(manifest) {
  return [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || [])
  ];
}

function popupReferences(html) {
  return Array.from(html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)="([^"]+)"/g), (match) => match[1]);
}

function workerImports(source) {
  return Array.from(source.matchAll(/importScripts\(([\s\S]*?)\);/g))
    .flatMap((call) => Array.from(call[1].matchAll(/"([^"]+\.js)"/g), (match) => match[1]));
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gladiatus-full-build-"));
  try {
    const outputDir = path.join(tempRoot, "full");
    const first = buildTool.build({ outputDir });
    const sourceFiles = buildTool.listFiles(buildTool.sourceDir).map((file) => path.join("src", file));
    assert.deepEqual(recursiveFiles(outputDir), ["manifest.json", ...sourceFiles].sort());
    assert.deepEqual(first.files.slice().sort(), ["manifest.json", ...sourceFiles].sort());

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "Gladiatus Helper (Unofficial)");
    for (const file of manifestFiles(manifest)) {
      assert.equal(fs.existsSync(path.join(outputDir, file)), true, `${file} is referenced by the full manifest`);
    }

    const popupPath = path.join(outputDir, manifest.action.default_popup);
    const popupDirectory = path.dirname(popupPath);
    const popupHtml = fs.readFileSync(popupPath, "utf8");
    for (const reference of popupReferences(popupHtml)) {
      assert.equal(fs.existsSync(path.resolve(popupDirectory, reference)), true, `${reference} is referenced by the full popup`);
    }

    const workerPath = path.join(outputDir, manifest.background.service_worker);
    const workerDirectory = path.dirname(workerPath);
    const workerSource = fs.readFileSync(workerPath, "utf8");
    for (const reference of workerImports(workerSource)) {
      assert.equal(fs.existsSync(path.resolve(workerDirectory, reference)), true, `${reference} is imported by the full worker`);
    }

    for (const file of recursiveFiles(outputDir).filter((name) => name.endsWith(".js"))) {
      childProcess.execFileSync(process.execPath, ["--check", path.join(outputDir, file)], { stdio: "pipe" });
    }

    const second = buildTool.build({ outputDir });
    assert.deepEqual(second.files.slice().sort(), first.files.slice().sort(), "owned full builds are repeatable");
    assert.throws(
      () => buildTool.build({ outputDir: path.join(rootDir, "src") }),
      /unsafe output directory/,
      "the full build must not target source directories"
    );
    const unowned = path.join(tempRoot, "unowned");
    fs.mkdirSync(unowned);
    fs.writeFileSync(path.join(unowned, "keep.txt"), "keep", "utf8");
    assert.throws(() => buildTool.build({ outputDir: unowned }), /not owned by this build/);
    assert.equal(fs.readFileSync(path.join(unowned, "keep.txt"), "utf8"), "keep");

    const topLevelJavaScript = fs.readdirSync(rootDir).filter((file) => file.endsWith(".js"));
    assert.deepEqual(topLevelJavaScript, [], "implementation and test JavaScript belong in named directories");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("full build tests passed");
}

main();
