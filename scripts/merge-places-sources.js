/**
 * Concatenates multiple CDC PLACES tract GeoJSON files into one FeatureCollection,
 * then optionally filters to study-area GEOIDs (same as filter-places-by-tracts).
 *
 * Usage (from Health Demographics Dashboard folder):
 *   node scripts/merge-places-sources.js --tracts data/tracts_saratoga_50mi.geojson --out data/PLACES_saratoga_50mi.geojson file2019.geojson file2021.geojson file2023.geojson
 *
 * Without --tracts: merges all features without GEOID filtering (not recommended for prod).
 */

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { writePlacesManifest } = require("./places-manifest-lib.js");
const {
  geoidFromPlacesProps,
  normalizeTractLocationProps,
} = require("./places-tract-props.js");

function parseArgs(argv) {
  var sources = [];
  var out = null;
  var tracts = null;
  var manifest = null;
  var slim = false;
  var minYear = null;
  var i;
  for (i = 2; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      out = path.resolve(argv[++i]);
    } else if (argv[i] === "--tracts" && argv[i + 1]) {
      tracts = path.resolve(argv[++i]);
    } else if (argv[i] === "--manifest" && argv[i + 1]) {
      manifest = path.resolve(argv[++i]);
    } else if (argv[i] === "--slim") {
      slim = true;
    } else if (argv[i] === "--min-year" && argv[i + 1]) {
      minYear = parseInt(argv[++i], 10);
    } else if (!argv[i].startsWith("--")) {
      sources.push(path.resolve(argv[i]));
    }
  }
  return {
    sources: sources,
    out: out,
    tracts: tracts,
    manifest: manifest,
    slim: slim,
    minYear: minYear,
  };
}

var SLIM_PROP_KEYS = [
  "year",
  "Year",
  "stateabbr",
  "StateAbbr",
  "category",
  "Category",
  "measure",
  "Measure",
  "data_value",
  "Data_Value",
  "totalpopulation",
  "TotalPopulation",
  "totalpop18plus",
  "TotalPop18plus",
  "locationname",
  "LocationName",
  "locationid",
  "LocationId",
  "categoryid",
  "CategoryId",
  "measureid",
  "MeasureId",
  "short_question_text",
  "Short_Question_Text",
];

function slimProperties(props) {
  var np = {};
  var i;
  for (i = 0; i < SLIM_PROP_KEYS.length; i++) {
    var k = SLIM_PROP_KEYS[i];
    if (props[k] != null && props[k] !== "") np[k] = props[k];
  }
  return np;
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
  if (!args.out) {
    console.error("Usage: merge-places-sources.js --out path/out.geojson [--tracts tracts.geojson] <source1.geojson> [source2 ...]");
    process.exit(1);
  }
  if (!args.sources.length) {
    console.error("Provide at least one PLACES source GeoJSON.");
    process.exit(1);
  }

  var allowed = null;
  if (args.tracts) {
    if (!fs.existsSync(args.tracts)) {
      console.error("Tracts file not found:", args.tracts);
      process.exit(1);
    }
    var tractFc = JSON.parse(fs.readFileSync(args.tracts, "utf8"));
    allowed = loadGeoidSet(tractFc);
    console.log("Filtering to", allowed.size, "tract GEOIDs from", path.basename(args.tracts));
  }

  var merged = [];
  var si;
  for (si = 0; si < args.sources.length; si++) {
    var fp = args.sources[si];
    if (!fs.existsSync(fp)) {
      console.error("Missing source:", fp);
      process.exit(1);
    }
    var fc = JSON.parse(fs.readFileSync(fp, "utf8"));
    var feats = fc.features || [];
    var fi;
    var skipped = 0;
    var keptThisFile = 0;
    for (fi = 0; fi < feats.length; fi++) {
      var gid = geoidFromPlacesProps(feats[fi].properties);
      if (allowed && (!gid || !allowed.has(gid))) {
        skipped++;
        continue;
      }
      var normalizedProps = normalizeTractLocationProps(feats[fi].properties, gid);
      if (args.minYear != null && isFinite(args.minYear)) {
        var yr = parseInt(normalizedProps.year != null ? normalizedProps.year : normalizedProps.Year, 10);
        if (!isFinite(yr) || yr < args.minYear) {
          skipped++;
          continue;
        }
      }
      if (args.slim) normalizedProps = slimProperties(normalizedProps);
      merged.push({
        type: "Feature",
        geometry: args.slim ? null : feats[fi].geometry,
        properties: normalizedProps,
      });
      keptThisFile++;
    }
    console.log(path.basename(fp), "→ kept", keptThisFile, "features (" + skipped + " skipped)");
  }

  var outFc = {
    type: "FeatureCollection",
    features: merged,
    meta: {
      description:
        "Merged PLACES sources filtered to study tracts when --tracts was used.",
      sources: args.sources.map(function (s) {
        return path.basename(s);
      }),
      generated_at: new Date().toISOString(),
    },
  };

  fs.writeFileSync(args.out, JSON.stringify(outFc), "utf8");
  console.log("Wrote", path.relative(process.cwd(), args.out), "(" + merged.length + " features)");

  var manifestPath =
    args.manifest || path.join(path.dirname(args.out), "places_manifest.json");
  writePlacesManifest(outFc, manifestPath);
}

main();
