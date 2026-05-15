/**
 * Builds a local census tract GeoJSON for the dashboard:
 * 1) Downloads NY / VT / MA tracts from Census TIGERweb (same queries as the old in-browser loader).
 * 2) Keeps tracts whose centroid lies within RADIUS_MILES (great-circle / "as the crow flies")
 *    of Saratoga Springs, NY.
 *
 * No npm dependencies — run with Node 18+:
 *   node scripts/build-tracts-local.js
 *
 * For polygon intersection clipping (smaller, exact boundaries vs. a disk), use:
 *   npm install && node scripts/build-clipped-tracts-turf.js
 */

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

var TIGER_TRACT_LAYER_ID = 8;

var STATE_FIPS_LIST = [
  { fips: "36", label: "New York" },
  { fips: "50", label: "Vermont" },
  { fips: "25", label: "Massachusetts" },
];

/** Saratoga Springs, NY — reference point (WGS84 lng, lat) */
var SARATOGA_LNG_LAT = [-73.7846, 43.0831];
var RADIUS_MILES = 50;

var OUT_FILE = path.join(__dirname, "..", "data", "tracts_saratoga_50mi.geojson");

function fetchJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) {
      throw new Error("HTTP " + r.status + " for " + url);
    }
    return r.json();
  });
}

function fetchTigerTractsPage(stateFips, offset, layerId) {
  var base =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/" +
    layerId +
    "/query";
  var qs = new URLSearchParams({
    f: "geojson",
    where: "STATE='" + stateFips + "'",
    outFields: "GEOID,NAME,STATE,COUNTY",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "2000",
    resultOffset: String(offset || 0),
    maxAllowableOffset: "0.00012",
  });
  return fetchJson(base + "?" + qs.toString());
}

function fetchAllTractsForState(stateFips, layerId) {
  var offset = 0;
  var all = [];

  function next() {
    return fetchTigerTractsPage(stateFips, offset, layerId).then(function (gj) {
      var feats = gj && gj.features ? gj.features : [];
      if (!feats.length) {
        return { type: "FeatureCollection", features: all };
      }
      all = all.concat(feats);
      if (feats.length < 2000) {
        return { type: "FeatureCollection", features: all };
      }
      offset += 2000;
      return next();
    });
  }

  return next();
}

function mergeFeatureCollections(parts) {
  var feats = [];
  for (var i = 0; i < parts.length; i++) {
    var fc = parts[i];
    if (fc && fc.features && fc.features.length) {
      feats = feats.concat(fc.features);
    }
  }
  return { type: "FeatureCollection", features: feats };
}

function coerceGeoids(fc) {
  if (!fc || !fc.features) return fc;
  for (var i = 0; i < fc.features.length; i++) {
    var p = fc.features[i].properties || {};
    var g =
      p.GEOID != null
        ? String(p.GEOID).trim()
        : p.geoid != null
          ? String(p.geoid).trim()
          : p.GEO_ID != null
            ? String(p.GEO_ID).trim()
            : null;
    if (g) {
      fc.features[i].properties = Object.assign({}, p, { GEOID: g });
    }
  }
  return fc;
}

function fetchTractsWithLayer(layerId) {
  return Promise.all(
    STATE_FIPS_LIST.map(function (s) {
      return fetchAllTractsForState(s.fips, layerId);
    })
  ).then(function (parts) {
    return coerceGeoids(mergeFeatureCollections(parts));
  });
}

function fetchTractsThreeStates() {
  return fetchTractsWithLayer(TIGER_TRACT_LAYER_ID).catch(function (err) {
    console.warn(
      "Layer",
      TIGER_TRACT_LAYER_ID,
      "failed; retrying alternate layer index.",
      err.message || err
    );
    var alt = TIGER_TRACT_LAYER_ID === 8 ? 9 : 8;
    return fetchTractsWithLayer(alt);
  });
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

/** Haversine distance in miles (WGS84). */
function haversineMiles(lng1, lat1, lng2, lat2) {
  var R = 3958.7613;
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lng2 - lng1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function ringCentroid(ring) {
  if (!ring || ring.length < 2) return null;
  var n = ring.length - 1;
  var sx = 0;
  var sy = 0;
  var i;
  for (i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

function centroidFromGeometry(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") {
    return ringCentroid(geom.coordinates[0]);
  }
  if (geom.type === "MultiPolygon") {
    var best = null;
    var bestArea = -1;
    var p;
    for (p = 0; p < geom.coordinates.length; p++) {
      var ring = geom.coordinates[p][0];
      if (!ring || ring.length < 4) continue;
      var c = ringCentroid(ring);
      if (!c) continue;
      var len = ring.length;
      if (len > bestArea) {
        bestArea = len;
        best = c;
      }
    }
    return best;
  }
  return null;
}

function filterByCentroidRadius(fc, centerLngLat, radiusMi) {
  var out = [];
  var feats = fc.features || [];
  var i;
  for (i = 0; i < feats.length; i++) {
    var f = feats[i];
    var c = centroidFromGeometry(f.geometry);
    if (!c) continue;
    var d = haversineMiles(centerLngLat[0], centerLngLat[1], c[0], c[1]);
    if (d <= radiusMi + 1e-6) {
      out.push(f);
    }
  }
  return { type: "FeatureCollection", features: out };
}

function main() {
  console.log("Fetching census tracts (NY, VT, MA) from TIGERweb…");
  return fetchTractsThreeStates()
    .then(function (merged) {
      console.log("Downloaded features:", merged.features.length);

      var clipped = filterByCentroidRadius(merged, SARATOGA_LNG_LAT, RADIUS_MILES);
      console.log(
        "Tracts with centroid within",
        RADIUS_MILES,
        "mi of Saratoga Springs:",
        clipped.features.length
      );

      var collection = {
        type: "FeatureCollection",
        features: clipped.features,
        meta: {
          description:
            "Census tracts in NY, VT, and MA whose tract centroids lie within a " +
            RADIUS_MILES +
            "-mile great-circle radius of Saratoga Springs, NY. Full tract geometries are retained.",
          center_wgs84_lng_lat: SARATOGA_LNG_LAT,
          radius_miles: RADIUS_MILES,
          selection: "centroid_within_radius",
          source: "US Census Bureau TIGERweb (Current census tracts)",
          states_included: ["36", "50", "25"],
          generated_at: new Date().toISOString(),
          note:
            "For polygon intersection against a true circle (trimmed boundaries), run scripts/build-clipped-tracts-turf.js after npm install @turf/turf.",
        },
      };

      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.writeFileSync(OUT_FILE, JSON.stringify(collection), "utf8");
      console.log("Wrote", path.relative(process.cwd(), OUT_FILE));
    })
    .catch(function (err) {
      console.error(err);
      process.exit(1);
    });
}

main();
