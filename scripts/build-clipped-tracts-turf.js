/**
 * Same as build-tracts-local.js, but clips tract polygons to the intersection with a
 * geodesic circle (via @turf/turf). Produces smaller, exact boundaries at the 50 mi edge.
 *
 *   npm install
 *   npm run build:tracts:turf
 */

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

var TIGER_TRACT_LAYER_ID = 8;

var STATE_FIPS_LIST = [
  { fips: "36", label: "New York" },
  { fips: "50", label: "Vermont" },
  { fips: "25", label: "Massachusetts" },
];

/** Saratoga Springs, NY — downtown reference (WGS84, lng/lat) */
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

function clipFeatureToCircle(feature, circleFeature) {
  var geom = feature.geometry;
  if (!geom) return null;

  try {
    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      var inter = turf.intersect(
        turf.feature(geom, feature.properties || {}),
        circleFeature
      );
      if (!inter || !inter.geometry) return null;
      inter.properties = Object.assign({}, feature.properties || {});
      return inter;
    }
  } catch (e) {
    /* fall through */
  }

  try {
    var c = turf.centroid(feature);
    if (turf.booleanPointInPolygon(c, circleFeature)) {
      return JSON.parse(JSON.stringify(feature));
    }
  } catch (e2) {
    /* ignore */
  }

  return null;
}

function main() {
  console.log("Fetching census tracts (NY, VT, MA) from TIGERweb…");
  return fetchTractsThreeStates()
    .then(function (merged) {
      console.log("Downloaded features:", merged.features.length);

      var centerPt = turf.point(SARATOGA_LNG_LAT);
      var circle = turf.circle(centerPt, RADIUS_MILES, {
        steps: 128,
        units: "miles",
        properties: { kind: "saratoga_buffer_50mi" },
      });

      var clipped = [];
      var i;
      for (i = 0; i < merged.features.length; i++) {
        var f = merged.features[i];
        var out = clipFeatureToCircle(f, circle);
        if (out) clipped.push(out);
      }

      console.log("Tracts after 50 mi polygon clip:", clipped.length);

      var collection = {
        type: "FeatureCollection",
        features: clipped,
        meta: {
          description:
            "Census tract polygons intersected with a 50-mile geodesic circle around Saratoga Springs, NY.",
          center_wgs84_lng_lat: SARATOGA_LNG_LAT,
          radius_miles: RADIUS_MILES,
          selection: "polygon_intersection",
          source: "US Census Bureau TIGERweb (Current census tracts)",
          states_included: ["36", "50", "25"],
          generated_at: new Date().toISOString(),
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
