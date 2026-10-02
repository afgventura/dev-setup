#!/usr/bin/env node
/**
 * Re-applies the local `quietExtensionWarnings` patch to the globally installed pi.
 *
 * Why this exists: pi's own check ("Host-provided extension packages must be declared in
 * peerDependencies ... not dependencies") fires for third-party extension manifests that pi
 * cannot fix from its side, and pi 1.0.0 always renders startup diagnostics
 * (`showDiagnosticsWhenQuiet: true`), so `quietStartup` does not hide them either. The setting
 * that does gate them is implemented in the local pi fork (~/Workspace/pi, commit ff6be36fe),
 * but the pi actually run is the upstream npm build, which lacks it. This ports just that gate
 * into the installed dist.
 *
 * `install.sh pi` links this to ~/.pi/agent/patches/ and runs it. Re-run it after every
 * `pi update` / `npm i -g @earendil-works/pi-coding-agent`, which reinstalls the package and
 * drops the patch. Idempotent; exits 1 with a message if the installed pi differs from what it
 * knows how to patch (install.sh ignores that so a pi it cannot patch does not abort the run).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Find the installed pi package dir. `which pi` is a wrapper on this machine, so it is only one clue. */
function findPiRoot() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  const shim = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  if (shim) {
    const resolved = realpathSync(shim);
    if (resolved.endsWith(".js")) candidates.push(resolve(dirname(resolved), "../.."));
    // The PATH entry is often a shell shim; the real launcher is the npm global bin.
    for (const bin of ["/usr/local/bin", "/opt/homebrew/bin"]) {
      const wrapper = `${bin}/${shim.split("/").pop()}`;
      if (!existsSync(wrapper)) continue;
      const real = realpathSync(wrapper);
      if (real.endsWith(".js")) candidates.push(resolve(dirname(real), "../.."));
    }
  }
  for (const prefix of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
    candidates.push(join(prefix, "@earendil-works/pi-coding-agent"));
  }
  try {
    candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"));
  } catch {}
  const root = candidates.find((dir) => existsSync(join(dir, "dist/bundle/chunks")));
  if (!root) throw new Error(`pi package not found; tried:\n  ${candidates.join("\n  ")}`);
  return root;
}

const root = findPiRoot();

const GETTER_OLD = `    getQuietStartup() {
        const value = this.settings.quietStartup;
        return value === true || value === "header" ? value : false;
    }
`;
const GETTER_NEW = `${GETTER_OLD}    getQuietExtensionWarnings() {
        return this.settings.quietExtensionWarnings === true;
    }
`;
const CALL_OLD = `const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);`;
const CALL_NEW = `const packageWarnings = this.settingsManager.getQuietExtensionWarnings?.() ? [] : collectExtensionPackageWarnings(extensionPaths, metadataByPath);`;

const BUNDLE_GETTER_OLD = `getQuietStartup(){let value=this.settings.quietStartup;return value===!0||value==="header"?value:!1}`;
const BUNDLE_GETTER_NEW = `${BUNDLE_GETTER_OLD}getQuietExtensionWarnings(){return this.settings.quietExtensionWarnings===!0}`;
const bundleCall = (tail) =>
  [`packageWarnings=collectExtensionPackageWarnings(extensionPaths,metadataByPath),extensionsResult=await ${tail}`,
   `packageWarnings=this.settingsManager.getQuietExtensionWarnings?.()?[]:collectExtensionPackageWarnings(extensionPaths,metadataByPath),extensionsResult=await ${tail}`];

/** Each edit is [oldText, newText, expectedOccurrences]; skips when newText already appears. */
function apply(file, edits) {
  const before = readFileSync(file, "utf8");
  let text = before;
  for (const [oldText, newText, expected] of edits) {
    const already = text.split(newText).length - 1;
    const found = text.split(oldText).length - 1;
    if (already === expected) continue;
    if (already !== 0 || found !== expected) {
      throw new Error(
        `${file}: patch does not fit (want ${expected} of ${JSON.stringify(oldText.slice(0, 60))}, found ${found}; new text present ${already}×) — the installed pi changed, re-port the patch instead of forcing it`,
      );
    }
    text = text.split(oldText).join(newText);
  }
  if (text === before) console.log(`= already patched  ${file.replace(`${root}/`, "")}`);
  else {
    writeFileSync(file, text);
    console.log(`+ patched          ${file.replace(`${root}/`, "")}`);
  }
}

const chunksDir = join(root, "dist/bundle/chunks");
const bundleFile = readdirSync(chunksDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(chunksDir, name))
  .find((file) => readFileSync(file, "utf8").includes(BUNDLE_GETTER_OLD));
if (!bundleFile) throw new Error(`no bundle chunk under ${chunksDir} contains getQuietStartup()`);

apply(join(root, "dist/core/settings-manager.js"), [[GETTER_OLD, GETTER_NEW, 1]]);
apply(join(root, "dist/core/resource-loader.js"), [[CALL_OLD, CALL_NEW, 2]]);
apply(bundleFile, [
  [BUNDLE_GETTER_OLD, BUNDLE_GETTER_NEW, 1],
  [...bundleCall("this.loadFinalExtensionSet"), 1],
  [...bundleCall("loadExtensionsCached"), 1],
]);

console.log(`\npi at ${root}`);
console.log(`Set "quietExtensionWarnings": true in ~/.pi/agent/settings.json to hide the manifest warnings.`);
