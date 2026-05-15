/**
 * Run before local dev: if data/.census-api-key exists and acs_age_by_tract.json is not a full
 * Census extract, run fetch-acs-age-by-tract.js so the dashboard age-band UI has tract coverage.
 *
 * Usage: node scripts/ensure-acs-age-data.js [--force]
 * --force  Always refetch (slow).
 */
/* eslint-disable no-console */
var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var root = path.join(__dirname, "..");
var keyPath = path.join(root, "data", ".census-api-key");
var outPath = path.join(root, "data", "acs_age_by_tract.json");
var fetchScript = path.join(__dirname, "fetch-acs-age-by-tract.js");

/** Read start of large JSON without parsing the whole file. */
function peekBundleKind() {
  try {
    var fd = fs.openSync(outPath, "r");
    try {
      var buf = Buffer.alloc(24576);
      var n = fs.readSync(fd, buf, 0, buf.length, 0);
      var s = buf.slice(0, n).toString("utf8");
      var m = /"bundleKind"\s*:\s*"([^"]+)"/.exec(s);
      if (m) return m[1];
      if (/Illustrative|small sample|replace with a real/i.test(s)) return "sample";
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
}

function hasUsableKey() {
  try {
    var raw = fs.readFileSync(keyPath, "utf8");
    var lines = raw.split(/\r?\n/);
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.length > 0) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

var force = process.argv.indexOf("--force") >= 0;
var kind = peekBundleKind();
var need = force || kind !== "full";

if (!need) {
  console.log("ACS age data OK (bundleKind full). Use --force to refetch.");
  process.exit(0);
}

if (!hasUsableKey()) {
  console.warn(
    "Skipping ACS fetch: put your Census Data API key in data/.census-api-key (first non-empty line) or set CENSUS_API_KEY, then run npm run build:acs-age."
  );
  process.exit(0);
}

console.log("Building data/acs_age_by_tract.json from the Census API (several minutes possible)…");
var r = cp.spawnSync(process.execPath, [fetchScript], { stdio: "inherit", cwd: root });
process.exit(r.status != null ? r.status : 1);
