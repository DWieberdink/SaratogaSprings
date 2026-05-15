/**
 * Filters the full PLACES GeoJSON to rows whose tract GEOID appears in
 * data/tracts_saratoga_50mi.geojson (50 mi study area). Dramatically reduces
 * load time and memory in the browser.
 *
 * Usage (from Health Demographics Dashboard folder):
 *   node scripts/filter-places-by-tracts.js
 *
 * Optional args:
 *   node scripts/filter-places-by-tracts.js --source path/to/full.geojson --out path/to/out.geojson
 *
 * Multiple CDC releases (clip each to the same tracts, one combined file + manifest):
 *   npm run build:places:study
 *   (see scripts/merge-places-sources.js)
 */

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { writePlacesManifest } = require("./places-manifest-lib.js");
const {
  geoidFromPlacesProps,
  normalizeTractLocationProps,
} = require("./places-tract-props.js");

var DEFAULT_TRACTS = path.join(__dirname, "..", "data", "tracts_saratoga_50mi.geojson");
var DEFAULT_PLACES = path.join(
  __dirname,
  "..",
  "data",
  "PLACES__Local_Data_for_Better_Health,_Census_Tract_Data,_2025_release_20260511.geojson"
);
var DEFAULT_OUT = path.join(__dirname, "..", "data", "PLACES_saratoga_50mi.geojson");

function parseArgs(argv) {
  var out = { source: DEFAULT_PLACES, out: DEFAULT_OUT, tracts: DEFAULT_TRACTS };
  var i;
  for (i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      out.source = path.resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out.out = path.resolve(argv[++i]);
    } else if (argv[i] === "--tracts" && argv[i + 1]) {
      out.tracts = path.resolve(argv[++i]);
    }
  }
  return out;
}

function loadGeoidSet(tractFc) {
  var set = new Set();
  var feats = tractFc.features || [];
  var fi;
  for (fi = 0; fi < feats.length; fi++) {
    var p = feats[fi].properties || {};
    var g = p.GEOID != null ? p.GEOID : p.geoid != null ? p.geoid : null;
    if (g != null) set.add(String(g).trim());
  }
  return set;
}

function main() {
  var args = parseArgs(process.argv);

  if (!fs.existsSync(args.tracts)) {
    console.error("Tract file not found:", args.tracts);
    console.error("Run: node scripts/build-tracts-local.js");
    process.exit(1);
  }
  if (!fs.existsSync(args.source)) {
    console.error("PLACES source file not found:", args.source);
    process.exit(1);
  }

  console.log("Reading tract GEOIDs from", path.relative(process.cwd(), args.tracts));
  var tractFc = JSON.parse(fs.readFileSync(args.tracts, "utf8"));
  var allowed = loadGeoidSet(tractFc);
  console.log("Study-area tract GEOIDs:", allowed.size);

  var stat = fs.statSync(args.source);
  console.log(
    "Reading PLACES source:",
    path.relative(process.cwd(), args.source),
    "(" + Math.round(stat.size / 1024 / 1024) + " MB) — may take memory and time."
  );

  var placesFc = JSON.parse(fs.readFileSync(args.source, "utf8"));
  var feats = placesFc.features || [];
  var outFeats = [];
  var i;
  var skippedNoId = 0;
  var skippedOutside = 0;

  for (i = 0; i < feats.length; i++) {
    var gid = geoidFromPlacesProps(feats[i].properties);
    if (!gid) {
      skippedNoId++;
      continue;
    }
    if (!allowed.has(gid)) {
      skippedOutside++;
      continue;
    }
    var normalizedProps = normalizeTractLocationProps(feats[i].properties, gid);
    outFeats.push({
      type: "Feature",
      geometry: feats[i].geometry,
      properties: normalizedProps,
    });
  }

  console.log(
    "Kept",
    outFeats.length,
    "of",
    feats.length,
    "features (outside study area:",
    skippedOutside,
    "; missing tract id:",
    skippedNoId + ")"
  );

  var outFc = {
    type: "FeatureCollection",
    features: outFeats,
    meta: {
      description:
        "PLACES rows filtered to census tracts listed in tracts_saratoga_50mi.geojson (50 mi of Saratoga Springs).",
      source_file: path.basename(args.source),
      tract_definition: path.basename(args.tracts),
      generated_at: new Date().toISOString(),
    },
  };

  fs.writeFileSync(args.out, JSON.stringify(outFc), "utf8");
  var outStat = fs.statSync(args.out);
  console.log(
    "Wrote",
    path.relative(process.cwd(), args.out),
    "(" + Math.round(outStat.size / 1024) + " KB)"
  );

  writePlacesManifest(outFc, path.join(path.dirname(args.out), "places_manifest.json"));
}

main();
