/**
 * Shared manifest builder for PLACES FeatureCollections (survey years + measure×year matrix).
 */

const fs = require("fs");
const path = require("path");

function prop(obj, keys) {
  if (!obj) return null;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      var v = obj[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return null;
}

function rowYear(p) {
  var y = parseInt(prop(p, ["year", "Year"]), 10);
  return isNaN(y) ? null : y;
}

/**
 * @param {object} placesFc - GeoJSON FeatureCollection
 * @returns {{ surveyYears: number[], measureYearMatrix: Record<string, number[]> }}
 */
function computeManifestFromPlaces(placesFc) {
  var yearSet = new Set();
  var matrix = Object.create(null);
  var feats = placesFc.features || [];
  var fi;
  for (fi = 0; fi < feats.length; fi++) {
    var p = feats[fi].properties || {};
    var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
    var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
    if (!cid || !mid) continue;
    var yr = rowYear(p);
    if (yr == null) continue;
    yearSet.add(yr);
    var key = cid + "|" + mid;
    if (!matrix[key]) matrix[key] = new Set();
    matrix[key].add(yr);
  }
  var surveyYears = Array.from(yearSet).sort(function (a, b) {
    return b - a;
  });
  var measureYearMatrix = Object.create(null);
  var k;
  for (k in matrix) {
    if (!Object.prototype.hasOwnProperty.call(matrix, k)) continue;
    measureYearMatrix[k] = Array.from(matrix[k]).sort(function (a, b) {
      return b - a;
    });
  }
  return { surveyYears: surveyYears, measureYearMatrix: measureYearMatrix };
}

function writePlacesManifest(placesFc, manifestPath) {
  var computed = computeManifestFromPlaces(placesFc);
  var payload = {
    surveyYears: computed.surveyYears,
    measureYearMatrix: computed.measureYearMatrix,
    tractPolygonVintage: "2020",
    generated_at: new Date().toISOString(),
    notes:
      "surveyYears = BRFSS survey years present in the bundled PLACES file. measureYearMatrix lists years available per categoryid|measureid.",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    "Wrote manifest",
    path.relative(process.cwd(), manifestPath),
    "(" + computed.surveyYears.length + " survey years)"
  );
}

module.exports = {
  computeManifestFromPlaces: computeManifestFromPlaces,
  writePlacesManifest: writePlacesManifest,
};
