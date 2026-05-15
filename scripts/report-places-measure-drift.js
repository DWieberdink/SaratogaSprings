/**
 * Summarizes label drift across PLACES rows for manual QA before linking dashboards.
 * Reads a clipped FeatureCollection (e.g. PLACES_saratoga_50mi.geojson).
 *
 * Usage: node scripts/report-places-measure-drift.js [path/to/places.geojson]
 */

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function prop(obj, keys) {
  if (!obj) return "";
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      var v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}

function rowYear(p) {
  var y = parseInt(prop(p, ["year", "Year"]), 10);
  return isNaN(y) ? null : y;
}

function main() {
  var input =
    process.argv[2] ||
    path.join(__dirname, "..", "data", "PLACES_saratoga_50mi.geojson");
  if (!fs.existsSync(input)) {
    console.error("File not found:", input);
    process.exit(1);
  }
  var fc = JSON.parse(fs.readFileSync(input, "utf8"));
  var feats = fc.features || [];

  /** @type {Record<string, { shorts:Set<string>, measures:Set<string>, years:Set<number> }>} */
  var byKey = Object.create(null);
  var fi;
  for (fi = 0; fi < feats.length; fi++) {
    var p = feats[fi].properties || {};
    var cid = prop(p, ["categoryid", "CategoryId"]);
    var mid = prop(p, ["measureid", "MeasureId"]);
    if (!cid || !mid) continue;
    var key = cid + "|" + mid;
    if (!byKey[key]) {
      byKey[key] = {
        shorts: new Set(),
        measures: new Set(),
        years: new Set(),
      };
    }
    var sq = prop(p, ["short_question_text", "Short_Question_Text"]);
    var mv = prop(p, ["measure", "Measure"]);
    if (sq) byKey[key].shorts.add(sq);
    if (mv) byKey[key].measures.add(mv);
    var yr = rowYear(p);
    if (yr != null) byKey[key].years.add(yr);
  }

  var driftShort = [];
  var driftMeasure = [];
  var keys = Object.keys(byKey).sort();
  var ki;
  for (ki = 0; ki < keys.length; ki++) {
    var k = keys[ki];
    var row = byKey[k];
    if (row.shorts.size > 1) driftShort.push({ key: k, values: Array.from(row.shorts).sort() });
    if (row.measures.size > 1)
      driftMeasure.push({ key: k, values: Array.from(row.measures).sort() });
  }

  console.log("=== PLACES measure drift report ===");
  console.log("Input:", path.relative(process.cwd(), input));
  console.log("Measures (categoryid|measureid):", keys.length);
  console.log("");
  console.log("--- Short Question Text differs across rows for same measure key:", driftShort.length);
  driftShort.forEach(function (d) {
    console.log("\n" + d.key);
    d.values.forEach(function (v) {
      console.log("  • " + v);
    });
  });
  console.log("");
  console.log("--- Long \"measure\" label differs across rows for same measure key:", driftMeasure.length);
  driftMeasure.forEach(function (d) {
    console.log("\n" + d.key);
    d.values.forEach(function (v) {
      console.log("  • " + v);
    });
  });

  /** Gap years: measures missing BRFSS years vs global max span */
  var allYears = new Set();
  for (ki = 0; ki < keys.length; ki++) {
    var yset = byKey[keys[ki]].years;
    yset.forEach(function (y) {
      allYears.add(y);
    });
  }
  var sortedYears = Array.from(allYears).sort(function (a, b) {
    return a - b;
  });
  console.log("");
  console.log("--- BRFSS survey years present (any measure):", sortedYears.join(", "));
  var gaps = [];
  for (ki = 0; ki < keys.length; ki++) {
    var kk = keys[ki];
    var ys = Array.from(byKey[kk].years).sort(function (a, b) {
      return a - b;
    });
    var missing = sortedYears.filter(function (y) {
      return !byKey[kk].years.has(y);
    });
    if (missing.length && ys.length) gaps.push({ key: kk, missing: missing, has: ys });
  }
  gaps.sort(function (a, b) {
    return b.missing.length - a.missing.length;
  });
  console.log(
    "\n--- Measures missing one or more survey years (spot-check definitions):",
    gaps.length
  );
  var gi;
  for (gi = 0; gi < Math.min(gaps.length, 80); gi++) {
    var g = gaps[gi];
    console.log(
      g.key + " — missing " + g.missing.join(", ") + " (has " + g.has.join(", ") + ")"
    );
  }
  if (gaps.length > 80) console.log("… +" + (gaps.length - 80) + " more");
}

main();
