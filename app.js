(function () {
  "use strict";

  var MAPBOX_ACCESS_TOKEN =
    (typeof window !== "undefined" &&
      window.__SaratogaSiteConfig &&
      String(window.__SaratogaSiteConfig.mapboxAccessToken || "").trim()) ||
    "";

  var MAPBOX_STYLES = {
    light: "mapbox://styles/mapbox/light-v11",
    streets: "mapbox://styles/mapbox/streets-v12",
    satellite: "mapbox://styles/mapbox/satellite-v9",
  };

  /**
   * PLACES rows filtered to the same GEOIDs as data/tracts_saratoga_50mi.geojson (50 mi study area).
   * Regenerate after tract build or new PLACES release: npm run build:places:study (multi-release) or npm run filter:places (single source).
   */
  var PLACES_GEOJSON = "data/PLACES_saratoga_50mi.geojson";

  /** Built by merge/filter scripts — survey years + measure×year matrix (see places_manifest.json) */
  var PLACES_MANIFEST_URL = "data/places_manifest.json";

  /** Optional tract-level age bins (ACS B01001); loaded when the dashboard finishes wiring UI */
  var ACS_AGE_GEOJSON_URL = "data/acs_age_by_tract.json";

  /**
   * CDC PLACES product release year (tooltips / documentation; update when replacing the GeoJSON extract).
   * Row-level `year` in the file may still reflect BRFSS survey years (often one year behind the release).
   */
  var PLACES_RELEASE_YEAR = 2025;

  /**
   * Census tract polygons for the map — built offline from TIGERweb; includes tracts whose centroid lies
   * within a 50 mi great-circle radius of Saratoga Springs. Regenerate with:
   * node scripts/build-tracts-local.js (or npm run build:tracts:turf for polygon intersection clipping).
   */
  var TRACT_BOUNDARIES_GEOJSON = "data/tracts_saratoga_50mi.geojson";

  var DEFAULT_CENTER = [-73.7846, 43.0831];
  var DEFAULT_ZOOM = 11.2;

  var COLOR_RAMPS = {
    low: "#eff6ff",
    high: "#1e40af",
  };

  /**
   * Dashboard age groups (collapsed from Census B01001 fine bins).
   * Re-run npm run build:acs-age after updating b01001-tract-bin-map so under_18 is populated.
   */
  var ACS_DISPLAY_ORDER = ["under_18", "g18_34", "g35_54", "g55_64", "g65_84", "g85_up"];

  /** Sum fine bin counts across study tracts for one ACS end-year, then collapse to ACS_DISPLAY_ORDER. */
  function sumFineBinsAcrossStudyArea(year) {
    var data = STATE.acsAgeRaw;
    if (!data || !data.features) return null;
    var agg = Object.create(null);
    var feats = data.features;
    var i;
    for (i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      if (Number(pr.year) !== Number(year)) continue;
      var gid = normalizeGeoid(pr.GEOID != null ? pr.GEOID : pr.geoid);
      if (!gid || !tractGeoidInStudyRadius(gid, STATE.studyRadiusMiles)) continue;
      var bins = pr.ageBins || {};
      var bk;
      for (bk in bins) {
        if (!Object.prototype.hasOwnProperty.call(bins, bk)) continue;
        var n = Number(bins[bk]);
        if (!isFinite(n)) continue;
        agg[bk] = (agg[bk] || 0) + n;
      }
    }
    return Object.keys(agg).length ? agg : null;
  }

  function collapseFineBinsToDisplay(bins) {
    bins = bins || {};
    function n(k) {
      return Number(bins[k] || 0);
    }
    return {
      under_18: n("under_18"),
      g18_34: n("18_19") + n("20_24") + n("25_29") + n("30_34"),
      g35_54: n("35_39") + n("40_44") + n("45_49") + n("50_54"),
      g55_64: n("55_59") + n("60_64"),
      g65_84: n("65_69") + n("70_74") + n("75_79") + n("80_84"),
      g85_up: n("85_up"),
    };
  }

  function getMapTractFillMode() {
    var el = document.getElementById("map-tract-fill-select");
    var v = el && el.value ? String(el.value) : "health";
    if (v.indexOf("acs:") === 0) return { kind: "acs", band: v.slice(4) };
    return { kind: "health" };
  }

  function updateMapTractFillHint() {
    var hint = document.getElementById("map-tract-fill-hint");
    if (!hint) return;
    var m = getMapTractFillMode();
    if (m.kind === "health") {
      hint.textContent =
        "Percent / count use CDC PLACES for the selected health measure. Choose an ACS age band to map where people in each group live (tract share or count).";
    } else {
      hint.textContent =
        "Uses the ACS 5-year end-year from Population & aging. Percent = this band as a share of modeled tract population (all six groups). Count = people in the band.";
    }
  }

  function buildGeoidAcsDisplayMap(year) {
    var data = STATE.acsAgeRaw;
    var out = Object.create(null);
    if (!data || !data.features) return out;
    var feats = data.features;
    var i;
    for (i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      if (Number(pr.year) !== Number(year)) continue;
      var gid = normalizeGeoid(pr.GEOID != null ? pr.GEOID : pr.geoid);
      if (!gid) continue;
      out[gid] = collapseFineBinsToDisplay(pr.ageBins || {});
    }
    return out;
  }

  function joinTractsFromAcsAge(tractFc, geoidDisplayMap, bandKey, modeCount, radiusMiles) {
    var rm =
      radiusMiles != null && isFinite(Number(radiusMiles))
        ? Number(radiusMiles)
        : STATE.studyRadiusMiles;
    var feats = tractFc && tractFc.features ? tractFc.features : [];
    var out = [];
    var i;
    for (i = 0; i < feats.length; i++) {
      var f = feats[i];
      var p = Object.assign({}, f.properties || {});
      var gid = normalizeGeoid(p.GEOID);
      var inR = gid ? tractGeoidInStudyRadius(gid, rm) : false;
      p.choropleth_in_radius = inR;
      p.dashboard_measure_selected = false;
      p.dashboard_map_fill_kind = "acs";
      p.dashboard_acs_band_key = bandKey;
      var disp = gid ? geoidDisplayMap[gid] : null;
      var total = 0;
      if (disp) {
        var dj;
        for (dj = 0; dj < ACS_DISPLAY_ORDER.length; dj++) {
          total += Number(disp[ACS_DISPLAY_ORDER[dj]] || 0);
        }
      }
      var band = disp && isFinite(Number(disp[bandKey])) ? Number(disp[bandKey]) : 0;
      var has = !!(disp && total > 0 && isFinite(band));
      var sharePct = has && total > 0 ? (100 * band) / total : null;
      var v = null;
      if (has && inR) {
        v = modeCount ? band : sharePct;
      }
      p.choropleth_has_data = has;
      p.choropleth_value = v != null && isFinite(v) ? v : 0;
      p.choropleth_pct = sharePct;
      p.choropleth_count_est = band;
      p.choropleth_pop18 = total > 0 ? total : null;
      p.choropleth_sqrt_norm = 0;
      out.push({ type: "Feature", geometry: f.geometry, properties: p });
    }
    return { type: "FeatureCollection", features: out };
  }
  var ACS_DIST_BAR_SCALE_MAX = 100000;

  /** Preferred short_question_text for selected measures (manual editorial choice). */
  var CANONICAL_SHORT_BY_KEY = {
    "HLTHOUT|CANCER": "Cancer (non-skin) or Melanoma",
    "HLTHOUT|TEETHLOST": "All Teeth Lost",
    "HLTHSTAT|MHLTH": "Frequent Mental Distress",
    "HLTHSTAT|PHLTH": "Frequent Physical Distress",
    "PREVENT|BPMED": "Taking Blood Pressure Medication",
    "RISKBEH|CSMOKING": "Current Cigarette Smoking",
    "RISKBEH|SLEEP": "Short Sleep Duration (<7 hours)",
  };

  var OUTLINE_WHITE = "#ffffff";
  /** Default tract outlines before a health measure is chosen */
  var OUTLINE_GREY_LIGHT = "#d1d5db";

  var STATE = {
    tractBase: null,
    placesRaw: null,
    /** From places_manifest.json or derived client-side */
    placesManifest: null,
    /** BRFSS survey year driving choropleth + KPIs */
    selectedSurveyYear: null,
    catalogByKey: null,
    /** Latest joined tract GeoJSON pushed to the map source */
    currentJoinedFc: null,
    /** categoryId|measureId */
    selectedMeasureKey: "",
    mapLayersReady: false,
    /** Cached turf circle Feature for study-area ring + centroid marker */
    studyCircleFeat: null,
    /** Avoid duplicate tract mouse/click handlers after style reload */
    tractInteractionsWired: false,
    /** Study radius (mi) — mask + sidebar KPI inclusion by tract centroid */
    studyRadiusMiles: 50,
    /** ACS tract age FeatureCollection (B01001 bins); null until fetch succeeds */
    acsAgeRaw: null,
    selectedAcsYear: null,
    /** Baseline ACS end-year for % change column (same tract bins, study radius) */
    selectedAcsBaselineYear: null,
    /** Which B01001 age-bin keys are shown in the histogram (default all true) */
    acsBinEnabled: null,
    /** True after ACS age JSON has been loaded successfully */
    acsAgeFetched: false,
    /** Prevents overlapping fetch if wireUiAfterData runs twice */
    acsAgeFetchInFlight: false,
  };

  var map;
  var agingPanelToggleWired = false;
  var agingBandTogglesWired = false;
  var agingBandDropdownWired = false;
  var tractHoverId = null;
  var tractHoverPopup = null;
  /** GEOID -> [lng, lat] for tract centers */
  var tractCentroidByGeoid = Object.create(null);

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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setLoading(visible, title, detail) {
    var ov = document.getElementById("loading-overlay");
    var tEl = document.getElementById("loading-overlay-title");
    var dEl = document.getElementById("loading-overlay-detail");
    if (!ov) return;
    if (visible) {
      ov.hidden = false;
      if (tEl && title) tEl.textContent = title;
      if (dEl) dEl.textContent = detail || "";
    } else {
      ov.hidden = true;
      if (dEl) dEl.textContent = "";
    }
  }

  function fetchGeoJsonOk(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) {
        throw new Error("Could not load " + url + " (" + r.status + " " + r.statusText + ")");
      }
      return r.json();
    });
  }

  function normalizeGeoid(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s || null;
  }

  function bboxFromFc(fc) {
    if (typeof turf !== "undefined" && turf && typeof turf.bbox === "function") {
      try {
        return turf.bbox(fc);
      } catch (e) {
        /* fall through */
      }
    }
    return bboxManual(fc);
  }

  function bboxManual(fc) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    function walk(coords) {
      if (typeof coords[0] === "number") {
        var x = coords[0];
        var y = coords[1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        return;
      }
      for (var i = 0; i < coords.length; i++) walk(coords[i]);
    }
    if (!fc || !fc.features) return null;
    for (var f = 0; f < fc.features.length; f++) {
      var g = fc.features[f].geometry;
      if (g) walk(g.coordinates);
    }
    if (!isFinite(minX)) return null;
    return [minX, minY, maxX, maxY];
  }

  function coerceTractGeoids(fc) {
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

  function centroidLngLat(feature) {
    if (!feature || !feature.geometry) return null;
    if (typeof turf !== "undefined" && turf && typeof turf.centroid === "function") {
      try {
        var c = turf.centroid(feature);
        if (c && c.geometry && c.geometry.coordinates) return c.geometry.coordinates;
      } catch (eC) {
        /* fall through */
      }
    }
    var bb = bboxFromFc({ type: "FeatureCollection", features: [feature] });
    if (!bb) return null;
    return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  }

  function rebuildTractCentroidIndex(tractFc) {
    tractCentroidByGeoid = Object.create(null);
    if (!tractFc || !tractFc.features) return;
    var i;
    for (i = 0; i < tractFc.features.length; i++) {
      var f = tractFc.features[i];
      var gid = f.properties && f.properties.GEOID != null ? String(f.properties.GEOID) : null;
      if (!gid) continue;
      var ll = centroidLngLat(f);
      if (ll) tractCentroidByGeoid[gid] = ll;
    }
  }

  function propsForGeoid(geoid) {
    var fc = STATE.currentJoinedFc;
    if (!geoid || !fc || !fc.features) return null;
    var g = String(geoid);
    var i;
    for (i = 0; i < fc.features.length; i++) {
      var p = fc.features[i].properties;
      if (p && String(p.GEOID) === g) return p;
    }
    return null;
  }

  function buildStudyAreaMaskPolygon(circleFeat) {
    if (typeof turf === "undefined" || !turf || !turf.bboxPolygon) return null;
    try {
      var world = turf.bboxPolygon([-180, -85, 180, 85]);
      if (typeof turf.difference === "function" && typeof turf.featureCollection === "function") {
        /* Turf 7.2+: difference(FeatureCollection<[poly1, poly2]>) clips poly2 from poly1 */
        var diff = turf.difference(turf.featureCollection([world, circleFeat]));
        if (diff && diff.geometry) return diff;
      }
    } catch (eDiff) {
      /* manual fallback below */
    }
    try {
      var outer = [
        [-180, -85],
        [180, -85],
        [180, 85],
        [-180, 85],
        [-180, -85],
      ];
      var innerRing = circleFeat.geometry.coordinates[0].slice();
      innerRing.reverse();
      return {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [outer, innerRing],
        },
      };
    } catch (e2) {
      return null;
    }
  }

  function circleToLineStringFc(circleFeat) {
    var ring = circleFeat.geometry.coordinates[0];
    var coords = ring.slice();
    if (
      coords.length &&
      (coords[0][0] !== coords[coords.length - 1][0] ||
        coords[0][1] !== coords[coords.length - 1][1])
    ) {
      coords.push(coords[0]);
    }
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "study_radius_line" },
          geometry: { type: "LineString", coordinates: coords },
        },
      ],
    };
  }

  function tractGeoidInStudyRadius(geoid, radiusMiles) {
    var ll = tractCentroidByGeoid[geoid];
    if (!ll || typeof turf === "undefined" || !turf.distance || !turf.point) return false;
    var rm =
      radiusMiles != null && isFinite(Number(radiusMiles))
        ? Number(radiusMiles)
        : STATE.studyRadiusMiles;
    try {
      var d = turf.distance(turf.point(DEFAULT_CENTER), turf.point(ll), { units: "miles" });
      return d <= rm + 1e-9;
    } catch (eD) {
      return false;
    }
  }

  function filterIdxByRadius(idx, radiusMiles) {
    var out = Object.create(null);
    var k;
    for (k in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, k)) continue;
      if (tractGeoidInStudyRadius(k, radiusMiles)) out[k] = idx[k];
    }
    return out;
  }

  /** Census tract GEOIDs for New York State start with FIPS 36. */
  function tractGeoidIsNYState(geoid) {
    var digits = String(geoid == null ? "" : geoid).replace(/\D/g, "");
    return digits.length >= 2 && digits.slice(0, 2) === "36";
  }

  /** NY tracts whose centroids fall inside the study radius (same rule as map/KPI tract filter). */
  function filterIdxByNyTractsInStudyRadius(idx, radiusMiles) {
    var out = Object.create(null);
    var k;
    for (k in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, k)) continue;
      if (!tractGeoidIsNYState(k)) continue;
      if (!tractGeoidInStudyRadius(k, radiusMiles)) continue;
      out[k] = idx[k];
    }
    return out;
  }

  /** Grey mask outside study radius + stash circle for ring / mask rebuild after style changes */
  function addStudyExtentLayersBeforeTracts() {
    if (!map || typeof turf === "undefined" || !turf.circle) return;
    var pt = turf.point(DEFAULT_CENTER);
    var rMi = Math.max(1, Math.min(50, Number(STATE.studyRadiusMiles) || 50));
    var circleFeat = turf.circle(pt, rMi, { units: "miles", steps: 96 });
    STATE.studyCircleFeat = circleFeat;
    var maskFeat = buildStudyAreaMaskPolygon(circleFeat);
    if (!maskFeat) return;
    if (!map.getSource("study-mask")) {
      map.addSource("study-mask", { type: "geojson", data: maskFeat });
      map.addLayer({
        id: "study-mask-fill",
        type: "fill",
        source: "study-mask",
        paint: {
          "fill-color": "#6b7280",
          "fill-opacity": 0.5,
        },
      });
    } else {
      try {
        map.getSource("study-mask").setData(maskFeat);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 50 mi boundary line + Saratoga Springs point — drawn above tract fills */
  function addStudyExtentLayersAfterTracts() {
    if (!map || !STATE.studyCircleFeat) return;
    var lineData = circleToLineStringFc(STATE.studyCircleFeat);
    var centerFc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Saratoga Springs, NY" },
          geometry: { type: "Point", coordinates: DEFAULT_CENTER },
        },
      ],
    };
    if (!map.getSource("study-circle")) {
      map.addSource("study-circle", { type: "geojson", data: lineData });
      map.addLayer({
        id: "study-circle-line",
        type: "line",
        source: "study-circle",
        paint: {
          "line-color": "#1e40af",
          "line-width": 2,
          "line-dasharray": [2, 2],
          "line-opacity": 0.92,
        },
      });
    } else {
      try {
        map.getSource("study-circle").setData(lineData);
      } catch (e2) {
        /* ignore */
      }
    }
    if (!map.getSource("saratoga-center")) {
      map.addSource("saratoga-center", { type: "geojson", data: centerFc });
      map.addLayer({
        id: "saratoga-center",
        type: "circle",
        source: "saratoga-center",
        paint: {
          "circle-radius": 6,
          "circle-color": "#1e40af",
          "circle-stroke-width": 2,
          "circle-stroke-color": OUTLINE_WHITE,
        },
      });
    } else {
      try {
        map.getSource("saratoga-center").setData(centerFc);
      } catch (e3) {
        /* ignore */
      }
    }
  }

  function rowYear(p) {
    var y = parseInt(prop(p, ["year", "Year"]), 10);
    return isNaN(y) ? -Infinity : y;
  }

  /**
   * @param {number|null|undefined} surveyYear - BRFSS year; when set, only that year's rows are used.
   *   When omitted, keeps the legacy behavior (latest year per tract for the measure).
   */
  function buildPlacesIndexForMeasure(placesFc, categoryId, measureId, surveyYear) {
    var best = Object.create(null);
    if (!placesFc || !placesFc.features) return best;
    var filterYear =
      surveyYear != null && isFinite(Number(surveyYear)) ? Number(surveyYear) : null;
    var fi;
    for (fi = 0; fi < placesFc.features.length; fi++) {
      var f = placesFc.features[fi];
      var p = f.properties || {};
      var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
      var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
      if (cid !== categoryId || mid !== measureId) continue;
      var gid = normalizeGeoid(prop(p, ["locationname", "LocationName", "locationid", "LocationId"]));
      if (!gid) continue;
      var pctRaw = prop(p, ["data_value", "Data_Value"]);
      /** Older PLACES tract releases often omit totalpop18plus and only publish totalpopulation. */
      var popRaw = prop(p, [
        "totalpop18plus",
        "TotalPop18plus",
        "totalpopulation",
        "TotalPopulation",
      ]);
      var pct = parseFloat(pctRaw);
      var pop = parseFloat(popRaw);
      if (!isFinite(pct) || !isFinite(pop)) continue;
      var yr = rowYear(p);
      if (filterYear != null) {
        if (yr !== filterYear) continue;
        best[gid] = {
          year: yr,
          pct: pct,
          pop: pop,
          measureText: String(prop(p, ["measure", "Measure"]) || ""),
          categoryText: String(prop(p, ["category", "Category"]) || ""),
          shortText: String(prop(p, ["short_question_text", "Short_Question_Text"]) || ""),
          stateabbr: String(prop(p, ["stateabbr", "StateAbbr"]) || ""),
        };
      } else {
        var prev = best[gid];
        if (!prev || yr >= prev.year) {
          best[gid] = {
            year: yr,
            pct: pct,
            pop: pop,
            measureText: String(prop(p, ["measure", "Measure"]) || ""),
            categoryText: String(prop(p, ["category", "Category"]) || ""),
            shortText: String(prop(p, ["short_question_text", "Short_Question_Text"]) || ""),
            stateabbr: String(prop(p, ["stateabbr", "StateAbbr"]) || ""),
          };
        }
      }
    }
    return best;
  }

  function computeStatsFromIndex(idx) {
    var sumPop = 0;
    var sumPctPop = 0;
    var sumCountEst = 0;
    var years = [];
    var k;
    for (k in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, k)) continue;
      var r = idx[k];
      sumPop += r.pop;
      sumPctPop += r.pct * r.pop;
      sumCountEst += (r.pct / 100) * r.pop;
      if (isFinite(r.year) && r.year > -Infinity) years.push(r.year);
    }
    years.sort(function (a, b) {
      return a - b;
    });
    var wMean = sumPop > 0 ? sumPctPop / sumPop : null;
    return {
      sumPop: sumPop,
      weightedMeanPct: wMean,
      sumCountEst: sumCountEst,
      minYear: years.length ? years[0] : null,
      maxYear: years.length ? years[years.length - 1] : null,
    };
  }

  function deriveManifestFromPlaces(placesFc) {
    var yearMap = Object.create(null);
    var matrix = Object.create(null);
    var feats = placesFc && placesFc.features ? placesFc.features : [];
    var fi;
    for (fi = 0; fi < feats.length; fi++) {
      var p = feats[fi].properties || {};
      var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
      var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
      if (!cid || !mid) continue;
      var yr = rowYear(p);
      if (!isFinite(yr) || yr === -Infinity) continue;
      yearMap[yr] = true;
      var key = cid + "|" + mid;
      if (!matrix[key]) matrix[key] = Object.create(null);
      matrix[key][yr] = true;
    }
    var surveyYears = Object.keys(yearMap)
      .map(Number)
      .sort(function (a, b) {
        return b - a;
      });
    var measureYearMatrix = Object.create(null);
    var k;
    for (k in matrix) {
      if (!Object.prototype.hasOwnProperty.call(matrix, k)) continue;
      measureYearMatrix[k] = Object.keys(matrix[k])
        .map(Number)
        .sort(function (a, b) {
          return b - a;
        });
    }
    return {
      surveyYears: surveyYears,
      measureYearMatrix: measureYearMatrix,
      tractPolygonVintage: "2020",
    };
  }

  function deriveYearsForMeasureFromFeatures(key) {
    var parts = key.split("|");
    if (parts.length < 2) return [];
    var cat = parts[0];
    var meas = parts[1];
    var ys = Object.create(null);
    var feats = STATE.placesRaw && STATE.placesRaw.features ? STATE.placesRaw.features : [];
    var fi;
    for (fi = 0; fi < feats.length; fi++) {
      var p = feats[fi].properties || {};
      var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
      var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
      if (cid !== cat || mid !== meas) continue;
      var yr = rowYear(p);
      if (isFinite(yr) && yr !== -Infinity) ys[yr] = true;
    }
    return Object.keys(ys).map(Number);
  }

  function getYearsForMeasureKey(key) {
    if (
      STATE.placesManifest &&
      STATE.placesManifest.measureYearMatrix &&
      STATE.placesManifest.measureYearMatrix[key]
    ) {
      return STATE.placesManifest.measureYearMatrix[key].slice();
    }
    return deriveYearsForMeasureFromFeatures(key);
  }

  function computeTimeSeriesForMeasure(placesFc, categoryId, measureId, radiusMiles) {
    var key = categoryId + "|" + measureId;
    var years = getYearsForMeasureKey(key);
    if (!years.length) return [];
    var asc = years.slice().sort(function (a, b) {
      return a - b;
    });
    var out = [];
    var yi;
    for (yi = 0; yi < asc.length; yi++) {
      var y = asc[yi];
      var idx = buildPlacesIndexForMeasure(placesFc, categoryId, measureId, y);
      var idxNyInRadius = filterIdxByNyTractsInStudyRadius(idx, radiusMiles);
      var nyGate = computeStatsFromIndex(idxNyInRadius);
      if (!(nyGate.sumPop > 0)) continue;

      var idxInRadius = filterIdxByRadius(idx, radiusMiles);
      var stats = computeStatsFromIndex(idxInRadius);
      out.push({
        year: y,
        weightedMeanPct: stats.weightedMeanPct,
        sumCountEst: stats.sumCountEst,
        sumPop: stats.sumPop,
      });
    }
    return out;
  }

  function updateTrendSectionHeading() {
    var el = document.getElementById("trend-section-heading");
    if (!el) return;
    var r = Math.max(1, Math.min(50, Number(STATE.studyRadiusMiles) || 50));
    el.textContent = "Study-area trends (" + r + " mi)";
  }

  function updateAcsPopTrendHeading() {
    var el = document.getElementById("acs-pop-trend-heading");
    if (!el) return;
    var r = Math.max(1, Math.min(50, Number(STATE.studyRadiusMiles) || 50));
    el.textContent = "Population by age (ACS) (" + r + " mi)";
  }

  function linearRegressionYears(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var sumX = 0;
    var sumY = 0;
    var sumXX = 0;
    var sumXY = 0;
    var i;
    for (i = 0; i < n; i++) {
      var x = xs[i];
      var y = ys[i];
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
    var denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return null;
    var m = (n * sumXY - sumX * sumY) / denom;
    var b = (sumY - m * sumX) / n;
    return { m: m, b: b };
  }

  /**
   * Simple SVG line chart into a container div (no external deps).
   * @param {(year: number, val: number) => string} [formatPointLine] — label above each point (value only; year is on the x-axis).
   * @param {{ linearTrend?: boolean, trendProjectYears?: number, trendFitYearMin?: number, trendFitYearMax?: number, compactChart?: boolean }} [trendOpts] — optional trend + styling; regression may use a subset of years when min/max set.
   */
  function renderSvgTrendChart(containerId, series, getY, formatTick, formatPointLine, trendOpts) {
    trendOpts = trendOpts || {};
    var wantLinearTrend = trendOpts.linearTrend === true;
    var trendProjectYears = isFinite(Number(trendOpts.trendProjectYears))
      ? Math.max(0, Number(trendOpts.trendProjectYears))
      : 3;
    var trendFitYearMin = trendOpts.trendFitYearMin;
    var trendFitYearMax = trendOpts.trendFitYearMax;
    var useFitYearWindow =
      trendFitYearMin != null &&
      trendFitYearMax != null &&
      isFinite(Number(trendFitYearMin)) &&
      isFinite(Number(trendFitYearMax));
    var compactChart = trendOpts.compactChart === true;
    var fsAxisTick = compactChart ? "6.5" : "8";
    var fsYear = compactChart ? "6" : "8";
    var fsVal = compactChart ? "6" : "7.5";
    var ptR = compactChart ? "1.65" : "2.25";
    var ptStrokeW = compactChart ? "0.5" : "0.75";
    var yearTextY = compactChart ? 10 : 12;
    var valOffset = compactChart ? 4.5 : 6;
    var valYMin = compactChart ? 7 : 9;
    var wrap = document.getElementById(containerId);
    if (!wrap) return;
    if (!series || !series.length) {
      wrap.innerHTML = '<p class="trend-chart-empty">No years available for this measure.</p>';
      return;
    }
    var w = 320;
    var h = 128;
    var padL = 40;
    var padR = 34;
    var padT = formatPointLine ? (compactChart ? 13 : 16) : 8;
    var padB = 26;
    var axisX0 = padL;
    var axisY0 = h - padB;
    var axisX1 = w - padR;
    var axisY1 = padT;
    var ys = [];
    var si;
    for (si = 0; si < series.length; si++) {
      var vy = getY(series[si]);
      if (vy != null && isFinite(vy)) ys.push(vy);
    }
    if (!ys.length) {
      wrap.innerHTML = '<p class="trend-chart-empty">No values to chart.</p>';
      return;
    }
    var dataMinX = series[0].year;
    var dataMaxX = series[series.length - 1].year;
    var plotMaxX =
      wantLinearTrend && series.length >= 2 ? dataMaxX + trendProjectYears : dataMaxX;
    var minY = Math.min.apply(null, ys);
    var maxY = Math.max.apply(null, ys);
    var reg = null;
    if (wantLinearTrend && series.length >= 2) {
      var xsR = [];
      var ysR = [];
      var ri;
      for (ri = 0; ri < series.length; ri++) {
        var yr = series[ri].year;
        if (useFitYearWindow && (yr < trendFitYearMin || yr > trendFitYearMax)) continue;
        var yv = getY(series[ri]);
        if (yv != null && isFinite(yv)) {
          xsR.push(yr);
          ysR.push(yv);
        }
      }
      if (xsR.length >= 2) {
        reg = linearRegressionYears(xsR, ysR);
      }
    }
    if (reg) {
      var yLineMin = reg.m * dataMinX + reg.b;
      var yLineMax = reg.m * plotMaxX + reg.b;
      minY = Math.min(minY, yLineMin, yLineMax);
      maxY = Math.max(maxY, yLineMin, yLineMax);
    }
    if (minY === maxY) {
      minY -= Math.abs(minY) * 0.08 + 1;
      maxY += Math.abs(maxY) * 0.08 + 1;
    }
    var minX = dataMinX;
    var maxX = plotMaxX;
    var dx = maxX - minX || 1;
    var dy = maxY - minY || 1;

    function xScale(yx) {
      return padL + ((yx - minX) / dx) * (w - padL - padR);
    }
    function yScale(v) {
      return padT + (1 - (v - minY) / dy) * (h - padT - padB);
    }

    var pts = [];
    for (si = 0; si < series.length; si++) {
      var yy = getY(series[si]);
      if (yy == null || !isFinite(yy)) continue;
      pts.push({
        x: xScale(series[si].year),
        y: yScale(yy),
        year: series[si].year,
        val: yy,
      });
    }
    var pathD = "";
    for (si = 0; si < pts.length; si++) {
      pathD += (si === 0 ? "M" : "L") + pts[si].x.toFixed(1) + "," + pts[si].y.toFixed(1) + " ";
    }
    if (!pts.length) {
      wrap.innerHTML = '<p class="trend-chart-empty">No plotted points for this measure.</p>';
      return;
    }

    var trendSvg = "";
    if (reg) {
      var yAtMin = reg.m * dataMinX + reg.b;
      var yAtMaxData = reg.m * dataMaxX + reg.b;
      var yAtPlotEnd = reg.m * plotMaxX + reg.b;
      if (plotMaxX > dataMaxX) {
        trendSvg +=
          '<line x1="' +
          xScale(dataMaxX).toFixed(1) +
          '" y1="' +
          axisY1.toFixed(1) +
          '" x2="' +
          xScale(dataMaxX).toFixed(1) +
          '" y2="' +
          axisY0.toFixed(1) +
          '" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="2 3"/>' +
          '<path d="M' +
          xScale(dataMinX).toFixed(1) +
          "," +
          yScale(yAtMin).toFixed(1) +
          " L" +
          xScale(dataMaxX).toFixed(1) +
          "," +
          yScale(yAtMaxData).toFixed(1) +
          '" fill="none" stroke="#64748b" stroke-width="1" stroke-linecap="round"/>' +
          '<path d="M' +
          xScale(dataMaxX).toFixed(1) +
          "," +
          yScale(yAtMaxData).toFixed(1) +
          " L" +
          xScale(plotMaxX).toFixed(1) +
          "," +
          yScale(yAtPlotEnd).toFixed(1) +
          '" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2" stroke-linecap="round"/>';
      } else {
        trendSvg +=
          '<path d="M' +
          xScale(dataMinX).toFixed(1) +
          "," +
          yScale(yAtMin).toFixed(1) +
          " L" +
          xScale(plotMaxX).toFixed(1) +
          "," +
          yScale(yAtPlotEnd).toFixed(1) +
          '" fill="none" stroke="#64748b" stroke-width="1" stroke-linecap="round"/>';
      }
    }

    var tickFill = "#6b7280";
    var axisStroke = "#d1d5db";
    var ff = "Libre Franklin, Arial Narrow, sans-serif";
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="xMidYMid meet" font-family="' +
      ff +
      '" font-weight="400">' +
      '<rect x="0" y="0" width="' +
      w +
      '" height="' +
      h +
      '" fill="#fff" stroke="none"/>' +
      '<line x1="' +
      axisX0.toFixed(1) +
      '" y1="' +
      axisY0.toFixed(1) +
      '" x2="' +
      axisX1.toFixed(1) +
      '" y2="' +
      axisY0.toFixed(1) +
      '" stroke="' +
      axisStroke +
      '" stroke-width="1"/>' +
      '<line x1="' +
      axisX0.toFixed(1) +
      '" y1="' +
      axisY1.toFixed(1) +
      '" x2="' +
      axisX0.toFixed(1) +
      '" y2="' +
      axisY0.toFixed(1) +
      '" stroke="' +
      axisStroke +
      '" stroke-width="1"/>' +
      '<text x="' +
      (axisX0 - 4).toFixed(1) +
      '" y="' +
      yScale(maxY).toFixed(1) +
      '" font-size="' +
      fsAxisTick +
      '" fill="' +
      tickFill +
      '" text-anchor="end" dominant-baseline="middle">' +
      escapeHtml(formatTick(maxY)) +
      "</text>" +
      '<text x="' +
      (axisX0 - 4).toFixed(1) +
      '" y="' +
      yScale(minY).toFixed(1) +
      '" font-size="' +
      fsAxisTick +
      '" fill="' +
      tickFill +
      '" text-anchor="end" dominant-baseline="middle">' +
      escapeHtml(formatTick(minY)) +
      "</text>" +
      trendSvg +
      '<path d="' +
      pathD.trim() +
      '" fill="none" stroke="#2563eb" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>';

    for (si = 0; si < pts.length; si++) {
      var pti = pts[si];
      svg +=
        '<text x="' +
        pti.x.toFixed(1) +
        '" y="' +
        (axisY0 + yearTextY).toFixed(1) +
        '" font-size="' +
        fsYear +
        '" fill="' +
        tickFill +
        '" text-anchor="middle">' +
        escapeHtml(String(pti.year)) +
        "</text>";
    }

    for (si = 0; si < pts.length; si++) {
      var pti2 = pts[si];
      svg +=
        '<circle cx="' +
        pti2.x.toFixed(1) +
        '" cy="' +
        pti2.y.toFixed(1) +
        '" r="' +
        ptR +
        '" fill="#1e40af" stroke="#fff" stroke-width="' +
        ptStrokeW +
        '"/>';
      if (formatPointLine) {
        svg +=
          '<text x="' +
          pti2.x.toFixed(1) +
          '" y="' +
          Math.max(valYMin, pti2.y - valOffset).toFixed(1) +
          '" font-size="' +
          fsVal +
          '" fill="#4b5563" text-anchor="middle" font-weight="400">' +
          escapeHtml(formatPointLine(pti2.year, pti2.val)) +
          "</text>";
      }
    }
    svg += "</svg>";
    wrap.innerHTML = svg;
  }

  function updateTrendCharts(series) {
    var note = document.getElementById("trend-insufficient-note");
    var cards = document.querySelector(".trend-chart-cards");
    var hasMeasure = !!parseMeasureKey(STATE.selectedMeasureKey || "");

    if (hasMeasure && (!series || series.length < 2)) {
      if (cards) cards.hidden = true;
      if (note) {
        note.hidden = false;
        note.textContent =
          "Trend charts are shown only when at least two BRFSS years have data for this measure.";
      }
      var wp = document.getElementById("chart-trend-pct");
      var wc = document.getElementById("chart-trend-count");
      if (wp) wp.innerHTML = "";
      if (wc) wc.innerHTML = "";
      return;
    }

    if (note) note.hidden = true;
    if (cards) cards.hidden = false;

    renderSvgTrendChart(
      "chart-trend-pct",
      series,
      function (pt) {
        return pt.weightedMeanPct;
      },
      function (v) {
        return v.toFixed(1) + "%";
      },
      function (year, val) {
        return val.toFixed(1) + "%";
      }
    );
    renderSvgTrendChart(
      "chart-trend-count",
      series,
      function (pt) {
        return pt.sumCountEst;
      },
      function (v) {
        return Math.round(v).toLocaleString();
      },
      function (year, val) {
        return Math.round(val).toLocaleString();
      }
    );
  }

  function collectAcsYearsFromData(data) {
    var yi = Object.create(null);
    var feats = data && data.features ? data.features : [];
    var i;
    for (i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      var y = pr.year != null ? Number(pr.year) : NaN;
      if (isFinite(y)) yi[y] = true;
    }
    return Object.keys(yi)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
  }

  function ensureAcsBinEnabledDefaults() {
    if (!STATE.acsBinEnabled) STATE.acsBinEnabled = Object.create(null);
    var i;
    for (i = 0; i < ACS_DISPLAY_ORDER.length; i++) {
      var k = ACS_DISPLAY_ORDER[i];
      if (STATE.acsBinEnabled[k] === undefined) STATE.acsBinEnabled[k] = true;
    }
  }

  function renderAgingBandToggles() {
    var host = document.getElementById("aging-band-toggles");
    if (!host) return;
    ensureAcsBinEnabledDefaults();
    var html = "";
    var i;
    for (i = 0; i < ACS_DISPLAY_ORDER.length; i++) {
      var k = ACS_DISPLAY_ORDER[i];
      var id = "aging-bin-" + k.replace(/[^a-z0-9_]/gi, "_");
      var on = STATE.acsBinEnabled[k] !== false;
      html +=
        '<label class="aging-band-toggle"><input type="checkbox" id="' +
        id +
        '" data-bin="' +
        escapeHtml(k) +
        '"' +
        (on ? " checked" : "") +
        " /> " +
        escapeHtml(formatAcsBinLabel(k)) +
        "</label>";
    }
    host.innerHTML = html;
    updateAgingBandDropdownSummary();
  }

  function wireAgingBandTogglesHost() {
    var host = document.getElementById("aging-band-toggles");
    if (!host || agingBandTogglesWired) return;
    agingBandTogglesWired = true;
    function onAgingBandCheckbox(ev) {
      var t = ev.target;
      if (!t || t.type !== "checkbox") return;
      var bin = t.getAttribute("data-bin");
      if (!bin) return;
      ensureAcsBinEnabledDefaults();
      STATE.acsBinEnabled[bin] = t.checked;
      updateAgingBandDropdownSummary();
      refreshAcsAgingDependentCharts();
    }
    host.addEventListener("change", onAgingBandCheckbox);
  }

  function sumBinsFromAggForEnabled(agg, orderKeys) {
    if (!agg) return 0;
    var s = 0;
    var i;
    for (i = 0; i < orderKeys.length; i++) {
      var k = orderKeys[i];
      if (STATE.acsBinEnabled[k] === false) continue;
      var n = Number(agg[k] || 0);
      if (isFinite(n)) s += n;
    }
    return s;
  }

  function computeAcsTotalPopSeries() {
    var data = STATE.acsAgeRaw;
    if (!data || !data.features || !data.features.length) return [];
    ensureAcsBinEnabledDefaults();
    var yearsAsc = collectAcsYearsFromData(data);
    var out = [];
    var yi;
    for (yi = 0; yi < yearsAsc.length; yi++) {
      var y = yearsAsc[yi];
      var agg = aggregateBinsForStudyArea(y);
      if (!agg) continue;
      var t = 0;
      var bi;
      for (bi = 0; bi < ACS_DISPLAY_ORDER.length; bi++) {
        var bk = ACS_DISPLAY_ORDER[bi];
        if (STATE.acsBinEnabled[bk] === false) continue;
        var n = Number(agg[bk] || 0);
        if (isFinite(n)) t += n;
      }
      out.push({ year: y, totalPop: t });
    }
    return out;
  }

  function refreshAcsTotalPopulationChart() {
    var wrap = document.getElementById("chart-acs-total-pop");
    if (!wrap) return;
    var titleEl = document.getElementById("acs-total-pop-chart-title");
    if (titleEl) {
      ensureAcsBinEnabledDefaults();
      var totBins = ACS_DISPLAY_ORDER.length;
      var sel = 0;
      var ti;
      for (ti = 0; ti < totBins; ti++) {
        if (STATE.acsBinEnabled[ACS_DISPLAY_ORDER[ti]] !== false) sel++;
      }
      if (sel === totBins) {
        titleEl.textContent = "Population total (all age groups)";
      } else if (sel === 0) {
        titleEl.textContent = "Population total (no groups selected)";
      } else {
        titleEl.textContent = "Population total (" + sel + " of " + totBins + " age groups)";
      }
    }
    updateAcsPopTrendHeading();
    var series = computeAcsTotalPopSeries();
    if (!series.length) {
      wrap.innerHTML =
        '<p class="trend-chart-empty">No ACS population data. Run npm run build:acs-age to rebuild.</p>';
      return;
    }
    renderSvgTrendChart(
      "chart-acs-total-pop",
      series,
      function (pt) {
        return pt.totalPop;
      },
      function (v) {
        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
        if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + "k";
        return Math.round(v).toLocaleString();
      },
      function (year, val) {
        return Math.round(val).toLocaleString();
      },
      {
        linearTrend: true,
        trendProjectYears: 3,
        trendFitYearMin: 2020,
        trendFitYearMax: 2024,
        compactChart: true,
      }
    );
  }

  function syncAcsYearControls(data) {
    var slider = document.getElementById("acs-year-slider");
    var readout = document.getElementById("acs-year-slider-readout");
    var loEl = document.getElementById("acs-year-slider-lo");
    var hiEl = document.getElementById("acs-year-slider-hi");
    if (!slider || !readout) return;
    var yearsAsc = collectAcsYearsFromData(data);
    if (!yearsAsc.length) {
      slider.disabled = true;
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
      readout.textContent = "—";
      if (loEl) loEl.textContent = "";
      if (hiEl) hiEl.textContent = "";
      STATE.selectedAcsYear = null;
      syncAcsBaselineYearSelect(data);
      return;
    }
    var n = yearsAsc.length;
    slider.min = "0";
    slider.max = String(Math.max(0, n - 1));
    var pref = STATE.selectedAcsYear;
    var prefIdx = pref != null ? yearsAsc.indexOf(Number(pref)) : -1;
    var chosenIdx = prefIdx >= 0 ? prefIdx : n - 1;
    var chosen = yearsAsc[chosenIdx];
    STATE.selectedAcsYear = chosen;
    slider.value = String(chosenIdx);
    readout.textContent = String(chosen);
    if (loEl) loEl.textContent = String(yearsAsc[0]);
    if (hiEl) hiEl.textContent = String(yearsAsc[n - 1]);
    slider.disabled = false;
    slider.setAttribute("aria-valuemin", String(yearsAsc[0]));
    slider.setAttribute("aria-valuemax", String(yearsAsc[n - 1]));
    slider.setAttribute("aria-valuenow", String(chosen));
    slider.setAttribute("aria-valuetext", "ACS 5-year estimate " + chosen);
    syncAcsBaselineYearSelect(data);
  }

  /** Oldest ACS end-year strictly before `currentYear`, or null if none. */
  function defaultAcsBaselineYear(yearsAsc, currentYear) {
    if (!yearsAsc.length || currentYear == null || !isFinite(Number(currentYear))) return null;
    var cy = Number(currentYear);
    var i;
    for (i = 0; i < yearsAsc.length; i++) {
      if (yearsAsc[i] < cy) return yearsAsc[i];
    }
    return null;
  }

  function syncAcsBaselineYearSelect(data) {
    var sel = document.getElementById("acs-baseline-year-select");
    if (!sel) return;
    var yearsAsc = collectAcsYearsFromData(data);
    if (!yearsAsc.length) {
      sel.innerHTML = "";
      sel.disabled = true;
      STATE.selectedAcsBaselineYear = null;
      return;
    }
    var curr = STATE.selectedAcsYear;
    var eligible = yearsAsc.filter(function (y) {
      return curr == null || y < curr;
    });
    if (!eligible.length) {
      sel.innerHTML = "";
      sel.disabled = true;
      STATE.selectedAcsBaselineYear = null;
      return;
    }
    var yearsDesc = eligible.slice().sort(function (a, b) {
      return b - a;
    });
    sel.innerHTML = "";
    var i;
    for (i = 0; i < yearsDesc.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(yearsDesc[i]);
      opt.textContent = String(yearsDesc[i]);
      sel.appendChild(opt);
    }
    sel.disabled = false;
    var pref = STATE.selectedAcsBaselineYear;
    var okPref = pref != null && eligible.indexOf(pref) >= 0;
    var chosen = okPref ? pref : defaultAcsBaselineYear(yearsAsc, curr);
    STATE.selectedAcsBaselineYear = chosen;
    if (chosen != null) sel.value = String(chosen);
  }

  function aggregateBinsForStudyArea(year) {
    var fine = sumFineBinsAcrossStudyArea(year);
    if (!fine) return null;
    return collapseFineBinsToDisplay(fine);
  }

  function countStudyTractsIndexed() {
    return Object.keys(tractCentroidByGeoid).length;
  }

  function countAcsGeoidsCoveringStudy(data) {
    if (!data || !data.features) return 0;
    var seen = Object.create(null);
    var rm = STATE.studyRadiusMiles;
    var i;
    for (i = 0; i < data.features.length; i++) {
      var pr = data.features[i].properties || {};
      var gid = normalizeGeoid(pr.GEOID != null ? pr.GEOID : pr.geoid);
      if (!gid || !tractGeoidInStudyRadius(gid, rm)) continue;
      seen[gid] = true;
    }
    return Object.keys(seen).length;
  }

  function syncAcsAgeCoverageNote() {
    var el = document.getElementById("aging-acs-coverage-note");
    if (!el) return;
    if (!STATE.acsAgeRaw) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    var meta = STATE.acsAgeRaw.meta || {};
    var tpl = countStudyTractsIndexed();
    var acsN = countAcsGeoidsCoveringStudy(STATE.acsAgeRaw);
    var desc = String(meta.description || "");
    var sample =
      meta.bundleKind === "sample" ||
      /illustrative|small sample|replace with a real/i.test(desc);
    var sparse =
      tpl >= 50 && acsN < Math.max(30, Math.floor(tpl * 0.3));
    if (!sample && !sparse) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent =
      "Totals here only add census tracts that appear in data/acs_age_by_tract.json (" +
      acsN +
      " tracts with rows vs. " +
      tpl +
      " tracts on the map). The Census API requires a free key; with one, run npm run build:acs-age once to overwrite that file with B01001 for every study tract (full 50 mi counts). Put the key in CENSUS_API_KEY or data/.census-api-key. See data/README_TRACT_VINTAGE.md.";
    el.hidden = false;
  }

  /** Human-readable label for ACS display group keys. */
  function formatAcsBinLabel(binKey) {
    var k = String(binKey);
    if (k === "under_18") return "Under 18";
    if (k === "g18_34") return "18–34";
    if (k === "g35_54") return "35–54";
    if (k === "g55_64") return "55–64";
    if (k === "g65_84") return "65–84";
    if (k === "g85_up") return "85+";
    if (k === "85_up") return "85+";
    if (k === "20_24") return "20–24";
    return k.replace(/_/g, "–");
  }

  function updateAgingBandDropdownSummary() {
    var sumEl = document.getElementById("aging-band-summary");
    var trig = document.getElementById("aging-band-trigger");
    var bulkSel = document.getElementById("aging-band-bulk-select");
    if (!sumEl) return;
    var host = document.getElementById("aging-band-toggles");
    if (!host || !host.children.length) {
      sumEl.textContent = "—";
      if (trig) {
        trig.disabled = true;
        trig.setAttribute("aria-valuetext", "Age groups unavailable");
        trig.setAttribute("aria-expanded", "false");
      }
      if (bulkSel) bulkSel.disabled = true;
      var emptyPanel = document.getElementById("aging-band-panel");
      if (emptyPanel) emptyPanel.hidden = true;
      return;
    }
    ensureAcsBinEnabledDefaults();
    if (trig) trig.disabled = false;
    if (bulkSel) bulkSel.disabled = false;
    var total = ACS_DISPLAY_ORDER.length;
    var selectedLabels = [];
    var i;
    var c = 0;
    for (i = 0; i < ACS_DISPLAY_ORDER.length; i++) {
      var bk = ACS_DISPLAY_ORDER[i];
      if (STATE.acsBinEnabled[bk] !== false) {
        c++;
        selectedLabels.push(formatAcsBinLabel(bk));
      }
    }
    var detail;
    if (c === 0) detail = "No age groups selected";
    else if (c === total) detail = "All age groups";
    else if (c <= 4) detail = selectedLabels.join(", ");
    else detail = c + " of " + total + " age groups";
    sumEl.textContent = detail;
    if (trig) trig.setAttribute("aria-valuetext", detail);
  }

  function setAgingBandDropdownOpen(open) {
    var panel = document.getElementById("aging-band-panel");
    var trig = document.getElementById("aging-band-trigger");
    if (!panel || !trig || trig.disabled) return;
    if (open) {
      panel.hidden = false;
      trig.setAttribute("aria-expanded", "true");
    } else {
      panel.hidden = true;
      trig.setAttribute("aria-expanded", "false");
    }
  }

  function wireAgingBandDropdown() {
    if (agingBandDropdownWired) return;
    var dropdown = document.getElementById("aging-band-dropdown");
    var trig = document.getElementById("aging-band-trigger");
    var panel = document.getElementById("aging-band-panel");
    var bulkSel = document.getElementById("aging-band-bulk-select");
    if (!dropdown || !trig || !panel) return;
    agingBandDropdownWired = true;
    trig.addEventListener("click", function (e) {
      e.stopPropagation();
      if (trig.disabled) return;
      var isOpen = trig.getAttribute("aria-expanded") === "true";
      setAgingBandDropdownOpen(!isOpen);
    });
    if (bulkSel) {
      bulkSel.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      bulkSel.addEventListener("change", function () {
        var v = bulkSel.value;
        if (v === "__all__") {
          ensureAcsBinEnabledDefaults();
          var ja;
          for (ja = 0; ja < ACS_DISPLAY_ORDER.length; ja++) {
            STATE.acsBinEnabled[ACS_DISPLAY_ORDER[ja]] = true;
          }
          renderAgingBandToggles();
          refreshAcsAgingDependentCharts();
        } else if (v === "__none__") {
          ensureAcsBinEnabledDefaults();
          var jn;
          for (jn = 0; jn < ACS_DISPLAY_ORDER.length; jn++) {
            STATE.acsBinEnabled[ACS_DISPLAY_ORDER[jn]] = false;
          }
          renderAgingBandToggles();
          refreshAcsAgingDependentCharts();
        }
        bulkSel.value = "";
      });
    }
    document.addEventListener("mousedown", function (e) {
      if (trig.getAttribute("aria-expanded") !== "true") return;
      if (!dropdown.contains(e.target)) setAgingBandDropdownOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (trig.getAttribute("aria-expanded") !== "true") return;
      setAgingBandDropdownOpen(false);
      trig.focus();
    });
  }

  /**
   * @returns {{ text: string, tone: 'pos'|'neg'|'neu' }}
   */
  function pctChangeDisplay(currentVal, baselineVal) {
    var c = Number(currentVal);
    var b = Number(baselineVal);
    if (!isFinite(c) || !isFinite(b)) return { text: "—", tone: "neu" };
    if (b === 0) {
      if (c === 0) return { text: "0%", tone: "neu" };
      return { text: "—", tone: "neu" };
    }
    var pct = ((c - b) / b) * 100;
    var s = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
    var tone = pct > 0 ? "pos" : pct < 0 ? "neg" : "neu";
    return { text: s, tone: tone };
  }

  function renderAgingHistogram(agg) {
    var el = document.getElementById("aging-histogram");
    if (!el) return;
    if (!agg || !Object.keys(agg).length) {
      el.innerHTML =
        '<p class="trend-chart-empty">No age-bin data for tracts inside the current study radius for this ACS year.</p>';
      return;
    }
    ensureAcsBinEnabledDefaults();
    var yb = STATE.selectedAcsBaselineYear;
    var yc = STATE.selectedAcsYear;
    var hasValidCompare =
      yb != null &&
      yc != null &&
      isFinite(Number(yb)) &&
      isFinite(Number(yc)) &&
      Number(yb) < Number(yc);
    var aggBase = hasValidCompare ? aggregateBinsForStudyArea(yb) : null;
    var order = ACS_DISPLAY_ORDER.slice();
    var extra = Object.keys(agg).filter(function (k) {
      return order.indexOf(k) < 0;
    });
    extra.sort();
    order = order.concat(extra);
    var enabledOrder = order.filter(function (k) {
      return STATE.acsBinEnabled[k] !== false;
    });
    if (!enabledOrder.length) {
      el.innerHTML =
        '<p class="trend-chart-empty">Select at least one age group to show the distribution and totals below.</p>';
      return;
    }
    var barScaleMax = 0;
    var j;
    for (j = 0; j < enabledOrder.length; j++) {
      var vMax = Number(agg[enabledOrder[j]] || 0);
      if (isFinite(vMax)) barScaleMax = Math.max(barScaleMax, vMax);
    }
    barScaleMax = Math.max(barScaleMax, 1);
    barScaleMax = Math.min(barScaleMax, ACS_DIST_BAR_SCALE_MAX);
    var sumC = sumBinsFromAggForEnabled(agg, enabledOrder);
    var sumB = aggBase ? sumBinsFromAggForEnabled(aggBase, enabledOrder) : NaN;
    var html = '<div class="aging-bars">';
    var i;
    for (i = 0; i < enabledOrder.length; i++) {
      var k = enabledOrder[i];
      var val = Number(agg[k] || 0);
      var baseVal = aggBase ? Number(aggBase[k] || 0) : NaN;
      var pct = barScaleMax > 0 ? Math.min(100, (100 * val) / barScaleMax) : 0;
      var pd =
        aggBase && hasValidCompare
          ? pctChangeDisplay(val, baseVal)
          : { text: "—", tone: "neu" };
      html +=
        '<div class="aging-bar-row" role="row">' +
        '<span class="aging-bar-label" role="cell">' +
        escapeHtml(formatAcsBinLabel(k)) +
        '</span><div class="aging-bar-track" role="cell"><div class="aging-bar-fill" style="width:' +
        pct.toFixed(1) +
        '%"></div></div><span class="aging-bar-val" role="cell">' +
        Math.round(val).toLocaleString() +
        '</span><span class="aging-bar-change aging-bar-change--' +
        pd.tone +
        '" role="cell">' +
        escapeHtml(pd.text) +
        "</span></div>";
    }
    var totalPd =
      aggBase && hasValidCompare && isFinite(sumB)
        ? pctChangeDisplay(sumC, sumB)
        : { text: "—", tone: "neu" };
    html +=
      '<div class="aging-bar-row aging-bar-row--summary" role="row">' +
      '<span class="aging-bar-label" role="cell">Total (selected groups)</span>' +
      '<div class="aging-bar-summary-gap" role="presentation"></div>' +
      '<span class="aging-bar-val" role="cell">' +
      Math.round(sumC).toLocaleString() +
      '</span><span class="aging-bar-change aging-bar-change--' +
      totalPd.tone +
      '" role="cell">' +
      escapeHtml(totalPd.text) +
      "</span></div>";
    html += "</div>";
    el.innerHTML = html;
  }

  function refreshAcsAgingDependentCharts() {
    if (!STATE.acsAgeRaw) return;
    refreshAgingVisualization();
    refreshAcsTotalPopulationChart();
  }

  function refreshAgingVisualization() {
    syncAcsAgeCoverageNote();
    var r = Math.max(1, Math.min(50, Number(STATE.studyRadiusMiles) || 50));
    var titleEl = document.getElementById("aging-histogram-title");
    if (titleEl) {
      titleEl.textContent = "Age distribution (" + r + " mi)";
    }
    var year = STATE.selectedAcsYear;
    var agg = year != null ? aggregateBinsForStudyArea(year) : null;
    renderAgingHistogram(agg);
  }

  function tryFetchAcsAge() {
    if (STATE.acsAgeFetched || STATE.acsAgeFetchInFlight) return;
    STATE.acsAgeFetchInFlight = true;
    fetch(ACS_AGE_GEOJSON_URL)
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (data) {
        STATE.acsAgeFetched = true;
        STATE.acsAgeRaw = data;
        syncAcsYearControls(data);
        renderAgingBandToggles();
        refreshAcsAgingDependentCharts();
        refreshChoroplethFromSelection();
      })
      .catch(function () {
        STATE.acsAgeRaw = null;
        var el = document.getElementById("aging-histogram");
        if (el) {
          el.innerHTML =
            '<p class="trend-chart-empty">Could not load data/acs_age_by_tract.json. Run npm run build:acs-age to rebuild.</p>';
        }
        var chartAcs = document.getElementById("chart-acs-total-pop");
        if (chartAcs) {
          chartAcs.innerHTML =
            '<p class="trend-chart-empty">Could not load data/acs_age_by_tract.json. Run npm run build:acs-age to rebuild.</p>';
        }
        var readout = document.getElementById("acs-year-slider-readout");
        if (readout) readout.textContent = "—";
        var acsSl = document.getElementById("acs-year-slider");
        if (acsSl) {
          acsSl.disabled = true;
          acsSl.value = "0";
        }
        var loEl = document.getElementById("acs-year-slider-lo");
        var hiEl = document.getElementById("acs-year-slider-hi");
        if (loEl) loEl.textContent = "";
        if (hiEl) hiEl.textContent = "";
        var toggles = document.getElementById("aging-band-toggles");
        if (toggles) toggles.innerHTML = "";
        updateAgingBandDropdownSummary();
        var baseSel = document.getElementById("acs-baseline-year-select");
        if (baseSel) {
          baseSel.innerHTML = "";
          baseSel.disabled = true;
        }
        STATE.selectedAcsBaselineYear = null;
      })
      .finally(function () {
        STATE.acsAgeFetchInFlight = false;
      });
  }

  function wireAgingPanel() {
    var panel = document.getElementById("aging-panel");
    if (!panel || agingPanelToggleWired) return;
    agingPanelToggleWired = true;
    var acsSlider = document.getElementById("acs-year-slider");
    if (acsSlider) {
      function applySliderYearFromIndex() {
        if (!STATE.acsAgeRaw) return;
        var yearsAsc = collectAcsYearsFromData(STATE.acsAgeRaw);
        if (!yearsAsc.length) return;
        var idx = parseInt(acsSlider.value, 10);
        if (!isFinite(idx)) idx = yearsAsc.length - 1;
        idx = Math.max(0, Math.min(yearsAsc.length - 1, idx));
        var y = yearsAsc[idx];
        STATE.selectedAcsYear = y;
        acsSlider.value = String(idx);
        var readout = document.getElementById("acs-year-slider-readout");
        if (readout) readout.textContent = String(y);
        acsSlider.setAttribute("aria-valuenow", String(y));
        acsSlider.setAttribute("aria-valuetext", "ACS 5-year estimate " + y);
        syncAcsBaselineYearSelect(STATE.acsAgeRaw);
        refreshAgingVisualization();
        if (getMapTractFillMode().kind === "acs") {
          refreshChoroplethFromSelection();
        }
      }
      acsSlider.addEventListener("input", applySliderYearFromIndex);
      acsSlider.addEventListener("change", applySliderYearFromIndex);
    }
    var baseSel = document.getElementById("acs-baseline-year-select");
    if (baseSel) {
      baseSel.addEventListener("change", function () {
        var bv = parseInt(baseSel.value, 10);
        STATE.selectedAcsBaselineYear = isFinite(bv) ? bv : null;
        refreshAgingVisualization();
      });
    }
    wireAgingBandTogglesHost();
    wireAgingBandDropdown();
  }

  function joinTracts(tractFc, idx, modeCount, radiusMiles, measureSelected) {
    var rm =
      radiusMiles != null && isFinite(Number(radiusMiles))
        ? Number(radiusMiles)
        : STATE.studyRadiusMiles;
    var measureOn = measureSelected === true;
    var feats = tractFc && tractFc.features ? tractFc.features : [];
    var out = [];
    var i;
    for (i = 0; i < feats.length; i++) {
      var f = feats[i];
      var p = Object.assign({}, f.properties || {});
      var gid = normalizeGeoid(p.GEOID);
      var inR = gid ? tractGeoidInStudyRadius(gid, rm) : false;
      p.choropleth_in_radius = inR;
      p.dashboard_measure_selected = measureOn;
      var row = gid ? idx[gid] : null;
      var has = !!(row && isFinite(row.pct) && isFinite(row.pop));
      var pct = has ? row.pct : null;
      var pop = has ? row.pop : null;
      var countEst = has ? (pct / 100) * pop : null;
      var v = null;
      if (has && inR) {
        v = modeCount ? countEst : pct;
      }
      p.choropleth_has_data = has;
      p.choropleth_value = v != null && isFinite(v) ? v : 0;
      p.choropleth_pct = pct != null ? pct : null;
      p.choropleth_count_est = countEst != null ? countEst : null;
      p.choropleth_pop18 = pop != null ? pop : null;
      p.choropleth_sqrt_norm = 0;
      out.push({ type: "Feature", geometry: f.geometry, properties: p });
    }
    return { type: "FeatureCollection", features: out };
  }

  /** Sqrt stretch of normalized value in [low,high] → [0,1] for Mapbox (style expr has no sqrt) */
  function augmentJoinedWithSqrtNorm(fc, low, high) {
    var d = Math.max(high - low, 1e-9);
    var feats = [];
    var i;
    for (i = 0; i < fc.features.length; i++) {
      var f = fc.features[i];
      var p = Object.assign({}, f.properties || {});
      if (p.choropleth_has_data && p.choropleth_in_radius) {
        var v = p.choropleth_value;
        var t = (v - low) / d;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        p.choropleth_sqrt_norm = Math.sqrt(t);
      } else {
        p.choropleth_sqrt_norm = 0;
      }
      feats.push({ type: "Feature", geometry: f.geometry, properties: p });
    }
    return { type: "FeatureCollection", features: feats };
  }

  /** Linear interpolation percentile on sorted array (p in 0–100) */
  function percentileFromSorted(sorted, p) {
    if (!sorted.length) return NaN;
    if (sorted.length === 1) return sorted[0];
    var idx = (p / 100) * (sorted.length - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    var t = idx - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  /**
   * Choropleth color ramp bounds: 10th–90th percentile when ≥3 values (reduces outlier skew).
   * Fewer than three values falls back to min/max.
   */
  function computeChoroplethRampBounds(joinedFc, modeCount) {
    var vals = [];
    var feats = joinedFc.features || [];
    var i;
    for (i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      if (!pr.choropleth_has_data || !pr.choropleth_in_radius) continue;
      var x = pr.choropleth_value;
      if (!isFinite(x)) continue;
      vals.push(x);
    }
    if (!vals.length) return { low: null, high: null };
    vals.sort(function (a, b) {
      return a - b;
    });
    var low;
    var high;
    if (vals.length < 3) {
      low = vals[0];
      high = vals[vals.length - 1];
    } else {
      low = percentileFromSorted(vals, 10);
      high = percentileFromSorted(vals, 90);
    }
    if (!isFinite(low) || !isFinite(high)) return { low: null, high: null };
    if (low === high || !isFinite(high - low)) {
      if (modeCount) {
        high = low + 1;
      } else {
        high = low + 0.1;
      }
    }
    return { low: low, high: high };
  }

  function formatLegendVal(modeCount, v) {
    if (v == null || !isFinite(v)) return "—";
    if (modeCount) {
      return Math.round(v).toLocaleString();
    }
    return v.toFixed(1) + "%";
  }

  /** Uses precomputed choropleth_sqrt_norm on each feature (sqrt stretch applied in augmentJoinedWithSqrtNorm). */
  function applyChoroplethPaint() {
    if (!map || !map.getLayer("tract-fill")) return;
    var fillExpr = [
      "case",
      ["==", ["get", "choropleth_in_radius"], false],
      "#d1d5db",
      ["==", ["get", "choropleth_has_data"], false],
      "#f3f4f6",
      [
        "interpolate",
        ["linear"],
        ["to-number", ["coalesce", ["get", "choropleth_sqrt_norm"], 0]],
        0,
        COLOR_RAMPS.low,
        1,
        COLOR_RAMPS.high,
      ],
    ];
    try {
      map.setPaintProperty("tract-fill", "fill-color", fillExpr);
    } catch (e1) {
      /* ignore */
    }
  }

  function applyNeutralTractFillPaint() {
    if (!map || !map.getLayer("tract-fill")) return;
    try {
      map.setPaintProperty("tract-fill", "fill-color", [
        "case",
        ["==", ["get", "choropleth_in_radius"], false],
        "#d1d5db",
        "#f3f4f6",
      ]);
    } catch (eN) {
      /* ignore */
    }
  }

  function refreshStudyExtentGeometry() {
    if (!map) return;
    addStudyExtentLayersBeforeTracts();
    addStudyExtentLayersAfterTracts();
  }

  function syncLegend(minV, maxV, modeCount, titleText) {
    var t = document.getElementById("map-choropleth-legend-title");
    var mn = document.getElementById("map-choropleth-legend-min");
    var mx = document.getElementById("map-choropleth-legend-max");
    var bar = document.getElementById("map-choropleth-legend-bar");
    if (t && titleText) t.textContent = titleText;
    if (mn) mn.textContent = minV == null ? "—" : formatLegendVal(modeCount, minV);
    if (mx) mx.textContent = maxV == null ? "—" : formatLegendVal(modeCount, maxV);
    if (bar) {
      bar.style.background =
        "linear-gradient(90deg, " + COLOR_RAMPS.low + " 0%, " + COLOR_RAMPS.high + " 100%)";
    }
  }

  function parseMeasureKey(sel) {
    if (!sel || sel.indexOf("|") < 0) return null;
    var parts = sel.split("|");
    return { categoryId: parts[0], measureId: parts[1] };
  }

  /**
   * Prefer "among adults"; keep explicit ages when cutoff/topic is below ~65 (screening ages, etc.).
   */
  function simplifyLongMeasureName(raw) {
    if (raw == null || String(raw).trim() === "") return "";
    var t = String(raw).trim();
    var keepSpecificAges =
      /aged\s*<\s*65|under\s*65|aged\s*\d+\s*[–-]\s*\d+|ages?\s*\d+\s*[–-]\s*\d+|among\s+women\s+aged|among\s+men\s+aged|among\s+adults\s+aged\s+(?!>=?\s*18)/i.test(
        t
      );
    if (keepSpecificAges) {
      return t
        .replace(/\s+among\s+adults\s+aged\s+>=\s*18\s*years/gi, " among adults")
        .replace(/\s+among\s+adults\s+ages?\s*>=\s*18\s*years/gi, " among adults")
        .trim();
    }
    t = t.replace(/\s+among\s+adults\s+aged\s+>=\s*18\s*years/gi, " among adults");
    t = t.replace(/\s+among\s+adults\s+ages?\s*>=\s*18\s*years/gi, " among adults");
    t = t.replace(/\s+among\s+adults\s+aged\s+>=\s*18\s*years/gi, " among adults");
    return t.trim();
  }

  function findFirstRowForMeasureYear(placesFc, categoryId, measureId, surveyYear) {
    if (!placesFc || !placesFc.features) return null;
    var sy = surveyYear != null && isFinite(Number(surveyYear)) ? Number(surveyYear) : null;
    var fi;
    for (fi = 0; fi < placesFc.features.length; fi++) {
      var p = placesFc.features[fi].properties || {};
      var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
      var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
      if (cid !== categoryId || mid !== measureId) continue;
      var yr = rowYear(p);
      if (sy != null && yr !== sy) continue;
      return p;
    }
    return null;
  }

  function getDisplayShortLabel(measureKey) {
    if (CANONICAL_SHORT_BY_KEY[measureKey]) return CANONICAL_SHORT_BY_KEY[measureKey];
    if (measureKey === "HLTHOUT|MHLTH") {
      return CANONICAL_SHORT_BY_KEY["HLTHSTAT|MHLTH"] || "Frequent Mental Distress";
    }
    if (measureKey === "HLTHOUT|PHLTH") {
      return CANONICAL_SHORT_BY_KEY["HLTHSTAT|PHLTH"] || "Frequent Physical Distress";
    }
    var e = STATE.catalogByKey && STATE.catalogByKey[measureKey];
    var s = e && (e.shortLabel || e.measureName);
    return (s && String(s).trim()) || measureKey;
  }

  function keysAvailableForYear(year) {
    var y = Number(year);
    if (!isFinite(y)) return [];
    var matrix = STATE.placesManifest && STATE.placesManifest.measureYearMatrix;
    if (!matrix) return [];
    var keys = [];
    var k;
    for (k in matrix) {
      if (!Object.prototype.hasOwnProperty.call(matrix, k)) continue;
      var yrs = matrix[k];
      if (!yrs || yrs.indexOf(y) < 0) continue;
      keys.push(k);
    }
    keys.sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
    var skip = Object.create(null);
    if (keys.indexOf("HLTHSTAT|MHLTH") >= 0 && keys.indexOf("HLTHOUT|MHLTH") >= 0) {
      skip["HLTHOUT|MHLTH"] = true;
    }
    if (keys.indexOf("HLTHSTAT|PHLTH") >= 0 && keys.indexOf("HLTHOUT|PHLTH") >= 0) {
      skip["HLTHOUT|PHLTH"] = true;
    }
    var out = [];
    var i;
    for (i = 0; i < keys.length; i++) {
      if (!skip[keys[i]]) out.push(keys[i]);
    }
    return out;
  }

  function getCatalogEntryForDisplay(measureKey, surveyYear) {
    var parsed = parseMeasureKey(measureKey);
    var short = getDisplayShortLabel(measureKey);
    var longRaw = null;
    if (parsed && STATE.placesRaw && surveyYear != null && isFinite(Number(surveyYear))) {
      var row = findFirstRowForMeasureYear(
        STATE.placesRaw,
        parsed.categoryId,
        parsed.measureId,
        Number(surveyYear)
      );
      if (row) longRaw = prop(row, ["measure", "Measure"]);
    }
    if (!longRaw && STATE.catalogByKey && STATE.catalogByKey[measureKey]) {
      longRaw = STATE.catalogByKey[measureKey].measureName;
    }
    var measureName = simplifyLongMeasureName(longRaw || "");
    return {
      key: measureKey,
      shortLabel: short,
      measureName: measureName || short,
    };
  }

  function populateSurveyYearsDropdown() {
    var sel = document.getElementById("survey-year-select");
    if (!sel) return;
    var years =
      STATE.placesManifest && STATE.placesManifest.surveyYears
        ? STATE.placesManifest.surveyYears.slice()
        : [];
    years.sort(function (a, b) {
      return b - a;
    });
    sel.innerHTML = "";
    var i;
    for (i = 0; i < years.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(years[i]);
      opt.textContent = String(years[i]);
      sel.appendChild(opt);
    }
    sel.disabled = years.length === 0;
    if (!years.length) {
      STATE.selectedSurveyYear = null;
      return;
    }
    var pref = STATE.selectedSurveyYear;
    var valid = pref != null && years.indexOf(pref) >= 0;
    STATE.selectedSurveyYear = valid ? pref : years[0];
    sel.value = String(STATE.selectedSurveyYear);
  }

  function updateKpis(stats, catalogEntry) {
    var popEl = document.getElementById("kpi-population");
    var metEl = document.getElementById("kpi-metric-value");
    var countEl = document.getElementById("kpi-estimated-count");
    if (popEl) {
      popEl.textContent =
        stats.sumPop > 0 ? Math.round(stats.sumPop).toLocaleString() : "—";
    }
    if (metEl) {
      metEl.textContent =
        stats.weightedMeanPct != null && isFinite(stats.weightedMeanPct)
          ? stats.weightedMeanPct.toFixed(1) + "%"
          : "—";
    }
    if (countEl) {
      if (stats.sumCountEst != null && isFinite(stats.sumCountEst)) {
        countEl.textContent = Math.round(stats.sumCountEst).toLocaleString();
      } else {
        countEl.textContent = "—";
      }
    }
    var mh = document.getElementById("metric-helper");
    if (mh && catalogEntry && catalogEntry.measureName) {
      mh.innerHTML =
        '<span class="metric-helper__label">Measure:</span> ' +
        '<span class="metric-helper__name">' +
        escapeHtml(String(catalogEntry.measureName)) +
        "</span>";
    } else if (mh) {
      mh.textContent = "";
    }
  }

  function buildCatalog(placesFc) {
    var rows = Object.create(null);
    if (!placesFc || !placesFc.features) return rows;
    var i;
    for (i = 0; i < placesFc.features.length; i++) {
      var p = placesFc.features[i].properties || {};
      var cid = String(prop(p, ["categoryid", "CategoryId"]) || "").trim();
      var mid = String(prop(p, ["measureid", "MeasureId"]) || "").trim();
      if (!cid || !mid) continue;
      var key = cid + "|" + mid;
      if (rows[key]) continue;
      rows[key] = {
        key: key,
        categoryId: cid,
        measureId: mid,
        categoryName: String(prop(p, ["category", "Category"]) || cid),
        measureName: String(prop(p, ["measure", "Measure"]) || mid),
        shortLabel: String(prop(p, ["short_question_text", "Short_Question_Text"]) || "").trim(),
      };
    }
    return rows;
  }

  /** Lists measures that have PLACES rows for STATE.selectedSurveyYear (manifest matrix). */
  function populateMetricDropdown() {
    var sel = document.getElementById("metric-select");
    if (!sel) return;
    var prev = sel.value;
    while (sel.firstChild) {
      sel.removeChild(sel.firstChild);
    }
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a measure…";
    sel.appendChild(placeholder);

    var year = STATE.selectedSurveyYear;
    if (year == null || !isFinite(Number(year))) return;

    var keys = keysAvailableForYear(Number(year));
    var catMap = Object.create(null);
    var ki;
    for (ki = 0; ki < keys.length; ki++) {
      var mk = keys[ki];
      var entry = STATE.catalogByKey && STATE.catalogByKey[mk];
      var catName = entry ? entry.categoryName || entry.categoryId : mk.split("|")[0];
      if (!catMap[catName]) catMap[catName] = [];
      catMap[catName].push({
        key: mk,
        sortLabel: getDisplayShortLabel(mk).toLowerCase(),
      });
    }
    var catNames = Object.keys(catMap).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
    var ci;
    for (ci = 0; ci < catNames.length; ci++) {
      var cn = catNames[ci];
      var og = document.createElement("optgroup");
      og.label = cn;
      var items = catMap[cn].slice().sort(function (a, b) {
        var c = a.sortLabel.localeCompare(b.sortLabel, undefined, { sensitivity: "base" });
        if (c !== 0) return c;
        return a.key.localeCompare(b.key);
      });
      var ji;
      for (ji = 0; ji < items.length; ji++) {
        var it = items[ji];
        var opt = document.createElement("option");
        opt.value = it.key;
        opt.textContent = getDisplayShortLabel(it.key);
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    if (prev && keys.indexOf(prev) >= 0) {
      sel.value = prev;
    }
  }

  function currentModeCount() {
    var c = document.getElementById("choropleth-count");
    return !!(c && c.checked);
  }

  function refreshChoroplethFromSelection() {
    if (!STATE.tractBase) return;
    if (!map || !map.getSource("tracts")) return;
    updateMapTractFillHint();
    var fill = getMapTractFillMode();

    if (fill.kind === "acs") {
      if (!STATE.acsAgeRaw) {
        STATE.currentJoinedFc = joinTracts(
          STATE.tractBase,
          Object.create(null),
          false,
          STATE.studyRadiusMiles,
          false
        );
        try {
          map.getSource("tracts").setData(STATE.currentJoinedFc);
        } catch (eAc0) {
          /* ignore */
        }
        applyNeutralTractFillPaint();
        syncLegend(null, null, currentModeCount(), "ACS age data not loaded");
        refreshTractTooltipContent();
        return;
      }
      var y = STATE.selectedAcsYear;
      if (y == null || !isFinite(Number(y))) {
        STATE.currentJoinedFc = joinTracts(
          STATE.tractBase,
          Object.create(null),
          false,
          STATE.studyRadiusMiles,
          false
        );
        try {
          map.getSource("tracts").setData(STATE.currentJoinedFc);
        } catch (eAc1) {
          /* ignore */
        }
        applyNeutralTractFillPaint();
        syncLegend(null, null, currentModeCount(), "Select ACS year in Population & aging");
        refreshTractTooltipContent();
        return;
      }
      var geoMap = buildGeoidAcsDisplayMap(y);
      var modeCount = currentModeCount();
      var joined = joinTractsFromAcsAge(
        STATE.tractBase,
        geoMap,
        fill.band,
        modeCount,
        STATE.studyRadiusMiles
      );
      var mm = computeChoroplethRampBounds(joined, modeCount);
      var finalFc =
        mm.low != null && mm.high != null ? augmentJoinedWithSqrtNorm(joined, mm.low, mm.high) : joined;
      STATE.currentJoinedFc = finalFc;
      try {
        map.getSource("tracts").setData(finalFc);
      } catch (eAc2) {
        /* ignore */
      }
      var bandLab = formatAcsBinLabel(fill.band);
      var legendTitle = bandLab + " — ACS " + y + (modeCount ? " (people)" : " (% of tract)");
      if (mm.low != null && mm.high != null) {
        applyChoroplethPaint();
        syncLegend(mm.low, mm.high, modeCount, legendTitle);
      } else {
        applyNeutralTractFillPaint();
        syncLegend(null, null, modeCount, legendTitle);
      }
      refreshTractTooltipContent();
      return;
    }

    var sel = document.getElementById("metric-select");
    var raw = sel && sel.value ? sel.value : "";
    STATE.selectedMeasureKey = raw;
    var parsed = parseMeasureKey(raw);
    var helperEntry = raw ? getCatalogEntryForDisplay(raw, STATE.selectedSurveyYear) : null;

    if (!parsed) {
      updateTrendCharts([]);
      STATE.currentJoinedFc = joinTracts(
        STATE.tractBase,
        Object.create(null),
        false,
        STATE.studyRadiusMiles,
        false
      );
      try {
        map.getSource("tracts").setData(STATE.currentJoinedFc);
      } catch (e0) {
        /* ignore */
      }
      applyNeutralTractFillPaint();
      syncLegend(null, null, false, "Select a measure");
      updateKpis(
        {
          sumPop: 0,
          weightedMeanPct: null,
          sumCountEst: null,
          minYear: null,
          maxYear: null,
        },
        null
      );
      var mh = document.getElementById("metric-helper");
      if (mh) mh.textContent = "";
      refreshTractTooltipContent();
      if (STATE.acsAgeRaw) {
        refreshAcsAgingDependentCharts();
      }
      return;
    }

    if (!STATE.placesRaw) {
      if (STATE.acsAgeRaw) {
        refreshAcsAgingDependentCharts();
      }
      return;
    }

    var idx = buildPlacesIndexForMeasure(
      STATE.placesRaw,
      parsed.categoryId,
      parsed.measureId,
      STATE.selectedSurveyYear
    );
    var idxInRadius = filterIdxByRadius(idx, STATE.studyRadiusMiles);
    var stats = computeStatsFromIndex(idxInRadius);
    var ts = computeTimeSeriesForMeasure(
      STATE.placesRaw,
      parsed.categoryId,
      parsed.measureId,
      STATE.studyRadiusMiles
    );
    updateTrendCharts(ts);
    var modeCount = currentModeCount();
    var joined = joinTracts(STATE.tractBase, idx, modeCount, STATE.studyRadiusMiles, true);
    var mm = computeChoroplethRampBounds(joined, modeCount);
    var finalFc =
      mm.low != null && mm.high != null ? augmentJoinedWithSqrtNorm(joined, mm.low, mm.high) : joined;
    STATE.currentJoinedFc = finalFc;

    try {
      map.getSource("tracts").setData(finalFc);
    } catch (e1) {
      /* ignore */
    }
    var legendTitle = (helperEntry && helperEntry.shortLabel) || "Selected measure";
    if (mm.low != null && mm.high != null) {
      applyChoroplethPaint();
      syncLegend(mm.low, mm.high, modeCount, legendTitle);
    } else {
      applyNeutralTractFillPaint();
      syncLegend(null, null, modeCount, legendTitle);
    }
    updateKpis(stats, helperEntry);
    refreshTractTooltipContent();
    if (STATE.acsAgeRaw) {
      refreshAcsAgingDependentCharts();
    }
  }

  function wireChoroplethModeCheckboxes() {
    var p = document.getElementById("choropleth-percent");
    var c = document.getElementById("choropleth-count");
    function syncMutual() {
      if (p && c) {
        if (p.checked) c.checked = false;
        if (c.checked) p.checked = false;
        if (!p.checked && !c.checked) p.checked = true;
      }
    }
    if (p) {
      p.addEventListener("change", function () {
        if (p.checked && c) c.checked = false;
        syncMutual();
        refreshChoroplethFromSelection();
      });
    }
    if (c) {
      c.addEventListener("change", function () {
        if (c.checked && p) p.checked = false;
        syncMutual();
        refreshChoroplethFromSelection();
      });
    }
  }

  function syncLayerVisibility() {
    var leg = document.getElementById("map-choropleth-legend");
    if (leg) leg.hidden = false;
  }

  function clearHover() {
    clearHoverOnly();
  }

  function removeHoverPopup() {
    if (tractHoverPopup) tractHoverPopup.remove();
  }

  function ensureHoverPopup() {
    if (!tractHoverPopup) {
      tractHoverPopup = new mapboxgl.Popup({
        className: "school-hover-popup",
        closeButton: false,
        closeOnClick: false,
        maxWidth: "300px",
        offset: 12,
        trackPointer: false,
        anchor: "bottom",
      });
    }
    return tractHoverPopup;
  }

  /** Tract number for header, e.g. "606.01" from "Census Tract 606.01" */
  function tractTooltipTractLabel(props) {
    var name = props && props.NAME != null ? String(props.NAME).trim() : "";
    if (name) {
      var stripped = name.replace(/^\s*census\s+tract\s*/i, "").trim();
      if (stripped) return stripped;
    }
    var g = props && props.GEOID != null ? String(props.GEOID) : "";
    return g || "—";
  }

  /** PLACES crude rate + count, or ACS age band when map fill is ACS. */
  function tractTooltipHtml(props) {
    var fill = getMapTractFillMode();
    if (fill.kind === "acs") {
      var tractLabA = tractTooltipTractLabel(props);
      var acsY =
        STATE.selectedAcsYear != null && isFinite(Number(STATE.selectedAcsYear))
          ? String(STATE.selectedAcsYear)
          : "—";
      var kickerA = ("Census tract " + tractLabA + " · ACS " + acsY).toUpperCase();
      var bandTitle = formatAcsBinLabel(fill.band);
      var hasA = props && props.choropleth_has_data;
      var share = props && props.choropleth_pct != null ? Number(props.choropleth_pct) : NaN;
      var cntA = props && props.choropleth_count_est != null ? props.choropleth_count_est : null;
      var totA = props && props.choropleth_pop18 != null ? props.choropleth_pop18 : null;
      var modeCountA = currentModeCount();
      var rowPctClassA =
        "school-hover-row tract-tooltip-metric" + (!modeCountA ? " tract-tip-emphasis" : "");
      var rowCntClassA =
        "school-hover-row tract-tooltip-metric" + (modeCountA ? " tract-tip-emphasis" : "");
      var metricsBlockA;
      if (!hasA) {
        metricsBlockA =
          '<div class="school-hover-row tract-tooltip-empty">No ACS modeled population for this tract in this ACS year.</div>';
      } else {
        metricsBlockA =
          '<div class="' +
          rowPctClassA +
          '">Share of tract (six ACS groups): ' +
          escapeHtml(isFinite(share) ? share.toFixed(1) + "%" : "—") +
          "</div>" +
          '<div class="' +
          rowCntClassA +
          '">People in band: ' +
          escapeHtml(
            cntA != null && isFinite(Number(cntA)) ? Math.round(Number(cntA)).toLocaleString() : "—"
          ) +
          "</div>";
      }
      var extraTotA =
        totA != null && isFinite(Number(totA))
          ? '<div class="school-hover-row school-hover-note">Modeled tract total (six groups): ' +
            escapeHtml(Math.round(Number(totA)).toLocaleString()) +
            "</div>"
          : "";
      var inRadiusA = props && props.choropleth_in_radius !== false;
      var radiusNoteA = inRadiusA
        ? ""
        : '<div class="school-hover-row school-hover-note">Outside current study radius — excluded from sidebar totals.</div>';
      return (
        '<div class="school-hover-inner school-hover-inner--tract">' +
        '<div class="tract-tooltip-kicker">' +
        escapeHtml(kickerA) +
        "</div>" +
        '<div class="school-hover-row tract-tooltip-metric tract-tip-emphasis">' +
        escapeHtml(bandTitle) +
        "</div>" +
        metricsBlockA +
        extraTotA +
        radiusNoteA +
        "</div>"
      );
    }

    var tractLab = tractTooltipTractLabel(props);
    var dataYear =
      STATE.selectedSurveyYear != null && isFinite(STATE.selectedSurveyYear)
        ? STATE.selectedSurveyYear
        : PLACES_RELEASE_YEAR;
    var kickerUpper = (
      "CENSUS TRACT " + tractLab + ", " + dataYear + " BRFSS DATA"
    ).toUpperCase();

    if (!parseMeasureKey(STATE.selectedMeasureKey || "")) {
      return (
        '<div class="school-hover-inner school-hover-inner--tract">' +
        '<div class="tract-tooltip-kicker">' +
        escapeHtml(kickerUpper) +
        '</div>' +
        '<div class="tract-tooltip-select-measure">Select a measure</div>' +
        "</div>"
      );
    }

    var disp = STATE.selectedMeasureKey
      ? getCatalogEntryForDisplay(STATE.selectedMeasureKey, STATE.selectedSurveyYear)
      : null;
    var measureTitle = disp ? String(disp.shortLabel || "").trim() : "";
    if (!measureTitle) measureTitle = "Select a measure";

    var has = props && props.choropleth_has_data;
    var pct = props && props.choropleth_pct != null ? props.choropleth_pct : null;
    var cnt = props && props.choropleth_count_est != null ? props.choropleth_count_est : null;
    var modeCount = currentModeCount();

    var rowPctClass =
      "school-hover-row tract-tooltip-metric" + (!modeCount ? " tract-tip-emphasis" : "");
    var rowCntClass =
      "school-hover-row tract-tooltip-metric" + (modeCount ? " tract-tip-emphasis" : "");

    var metricsBlock;
    if (!has) {
      metricsBlock =
        '<div class="school-hover-row tract-tooltip-empty">No PLACES estimate for this tract for the selected measure.</div>';
    } else {
      metricsBlock =
        '<div class="' +
        rowPctClass +
        '">Crude prevalence: ' +
        escapeHtml(Number(pct).toFixed(1)) +
        "%</div>" +
        '<div class="' +
        rowCntClass +
        '">Estimated adults affected: ' +
        escapeHtml(Math.round(cnt).toLocaleString()) +
        "</div>";
    }

    var inRadius = props && props.choropleth_in_radius !== false;
    var radiusNote = inRadius
      ? ""
      : '<div class="school-hover-row school-hover-note">Outside current study radius — excluded from sidebar totals.</div>';

    return (
      '<div class="school-hover-inner school-hover-inner--tract">' +
      '<div class="tract-tooltip-kicker">' +
      escapeHtml(kickerUpper) +
      "</div>" +
      '<div class="school-hover-row tract-tooltip-metric tract-tip-emphasis">' +
      escapeHtml(measureTitle) +
      "</div>" +
      metricsBlock +
      radiusNote +
      "</div>"
    );
  }

  function refreshTractTooltipContent() {
    try {
      if (tractHoverPopup && tractHoverPopup.isOpen()) {
        var ph = tractHoverId ? propsForGeoid(tractHoverId) : null;
        if (ph) tractHoverPopup.setHTML(tractTooltipHtml(ph));
      }
    } catch (eRf) {
      /* ignore */
    }
  }

  function setupTractInteractions() {
    if (STATE.tractInteractionsWired) return;
    STATE.tractInteractionsWired = true;
    map.on("mousemove", "tract-interaction", function (e) {
      map.getCanvas().style.cursor = "pointer";
      var f = e.features && e.features[0];
      if (!f || !f.properties) return;
      var id = f.properties.GEOID != null ? String(f.properties.GEOID) : null;
      if (!id) return;
      if (tractHoverId !== id) {
        clearHoverOnly();
        tractHoverId = id;
        try {
          map.setFeatureState({ source: "tracts", id: tractHoverId }, { hover: true });
        } catch (e1) {
          /* ignore */
        }
      }
      var hp = ensureHoverPopup();
      hp.setLngLat(e.lngLat).setHTML(tractTooltipHtml(f.properties));
      if (!hp.isOpen()) hp.addTo(map);
    });

    map.on("mouseleave", "tract-interaction", function () {
      map.getCanvas().style.cursor = "";
      clearHoverOnly();
    });
  }

  /** Clears hover outline + hover popup */
  function clearHoverOnly() {
    if (!map || !map.getSource("tracts")) return;
    if (tractHoverId != null) {
      try {
        map.setFeatureState({ source: "tracts", id: tractHoverId }, { hover: false });
      } catch (e) {
        /* ignore */
      }
      tractHoverId = null;
    }
    removeHoverPopup();
  }

  function addTractLayers(initialFc) {
    if (!map.getSource("tracts")) {
      map.addSource("tracts", {
        type: "geojson",
        data: initialFc,
        promoteId: "GEOID",
      });
      map.addLayer({
        id: "tract-fill",
        type: "fill",
        source: "tracts",
        paint: {
          "fill-color": "#f3f4f6",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            0.92,
            ["==", ["get", "choropleth_in_radius"], false],
            0.42,
            [
              "case",
              ["==", ["get", "choropleth_has_data"], true],
              0.78,
              0,
            ],
          ],
        },
      });
      map.addLayer({
        id: "tract-interaction",
        type: "fill",
        source: "tracts",
        paint: {
          "fill-color": "#ffffff",
          "fill-opacity": 0.01,
        },
      });
      map.addLayer({
        id: "tract-outline",
        type: "line",
        source: "tracts",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            [
              "case",
              ["==", ["coalesce", ["get", "dashboard_measure_selected"], false], true],
              OUTLINE_WHITE,
              "#e8eaef",
            ],
            [
              "case",
              ["==", ["coalesce", ["get", "dashboard_measure_selected"], false], true],
              OUTLINE_WHITE,
              OUTLINE_GREY_LIGHT,
            ],
          ],
          "line-blur": 0,
          "line-opacity": 1,
          /* Zoom top-level only — hover thickens stroke */
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            ["case", ["boolean", ["feature-state", "hover"], false], 2.8, 0.35],
            10,
            ["case", ["boolean", ["feature-state", "hover"], false], 4, 0.55],
            14,
            ["case", ["boolean", ["feature-state", "hover"], false], 5.2, 0.95],
          ],
        },
      });
      setupTractInteractions();
    } else {
      try {
        map.getSource("tracts").setData(initialFc);
      } catch (e2) {
        /* ignore */
      }
    }
    STATE.mapLayersReady = true;
    syncLayerVisibility();
  }

  function initDashboardResizer() {
    var dashboard = document.querySelector(".dashboard");
    var sidebar = document.getElementById("dashboard-sidebar");
    var resizer = document.getElementById("dashboard-resizer");
    if (!dashboard || !sidebar || !resizer) return;
    var dragging = false;
    function clampSidebarWidth(px) {
      var rect = dashboard.getBoundingClientRect();
      var resizerW = resizer.offsetWidth || 8;
      var minSide = 240;
      var minMap = 280;
      var max = rect.width - resizerW - minMap;
      return Math.max(minSide, Math.min(max, px));
    }
    function setSidebarWidth(px) {
      px = clampSidebarWidth(px);
      sidebar.style.flex = "0 0 " + px + "px";
      sidebar.style.width = px + "px";
      map.resize();
    }
    resizer.addEventListener("mousedown", function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = dashboard.getBoundingClientRect();
      setSidebarWidth(e.clientX - rect.left);
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  function setupToolbarCollapse() {
    var btn = document.getElementById("toolbar-toggle");
    var toolbar = document.getElementById("map-toolbar");
    if (!btn || !toolbar) return;
    btn.addEventListener("click", function () {
      var collapsed = toolbar.classList.toggle("toolbar--collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }

  function setMapboxBasemap(mode) {
    if (!MAPBOX_STYLES[mode]) return;
    var root = document.getElementById("basemap-toggle");
    if (root) {
      root.querySelectorAll("[data-basemap]").forEach(function (btn) {
        var active = btn.getAttribute("data-basemap") === mode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }
    map.once("style.load", function () {
      STATE.tractInteractionsWired = false;
      addStudyExtentLayersBeforeTracts();
      if (STATE.currentJoinedFc) {
        addTractLayers(STATE.currentJoinedFc);
      } else if (STATE.tractBase) {
        var selEl = document.getElementById("metric-select");
        var rawSel = selEl && selEl.value ? selEl.value : "";
        var blank = joinTracts(
          STATE.tractBase,
          Object.create(null),
          false,
          STATE.studyRadiusMiles,
          !!parseMeasureKey(rawSel)
        );
        addTractLayers(blank);
      }
      addStudyExtentLayersAfterTracts();
      refreshChoroplethFromSelection();
    });
    map.setStyle(MAPBOX_STYLES[mode]);
  }

  function wireUiAfterData() {
    setupToolbarCollapse();
    initDashboardResizer();
    wireChoroplethModeCheckboxes();

    var mapFillSel = document.getElementById("map-tract-fill-select");
    if (mapFillSel) {
      mapFillSel.addEventListener("change", function () {
        updateMapTractFillHint();
        refreshChoroplethFromSelection();
      });
    }
    updateMapTractFillHint();

    var basemapRoot = document.getElementById("basemap-toggle");
    if (basemapRoot) {
      basemapRoot.addEventListener("click", function (e) {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute("data-basemap")) {
          setMapboxBasemap(t.getAttribute("data-basemap"));
        }
      });
    }

    var sel = document.getElementById("metric-select");
    if (sel) {
      sel.addEventListener("change", refreshChoroplethFromSelection);
    }

    var sy = document.getElementById("survey-year-select");
    if (sy) {
      sy.addEventListener("change", function () {
        var v = parseInt(sy.value, 10);
        STATE.selectedSurveyYear = isFinite(v) ? v : null;
        populateMetricDropdown();
        var ms = document.getElementById("metric-select");
        if (ms && ms.value && STATE.selectedSurveyYear != null) {
          var ok =
            keysAvailableForYear(STATE.selectedSurveyYear).indexOf(ms.value) >= 0;
          if (!ok) ms.value = "";
        }
        refreshChoroplethFromSelection();
      });
    }

    wireAgingPanel();
    wireStudyRadiusSlider();
    tryFetchAcsAge();
  }

  function wireStudyRadiusSlider() {
    var sl = document.getElementById("study-radius-slider");
    var out = document.getElementById("study-radius-value");
    if (!sl) return;
    sl.value = String(Math.max(1, Math.min(50, Number(STATE.studyRadiusMiles) || 50)));
    function syncLabel() {
      if (out) out.textContent = sl.value + " mi";
      sl.setAttribute("aria-valuenow", sl.value);
      updateTrendSectionHeading();
      updateAcsPopTrendHeading();
    }
    sl.addEventListener("input", function () {
      var v = parseInt(sl.value, 10);
      if (!isFinite(v)) return;
      STATE.studyRadiusMiles = Math.max(1, Math.min(50, v));
      syncLabel();
      refreshStudyExtentGeometry();
      refreshChoroplethFromSelection();
    });
    syncLabel();
  }

  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

  map = new mapboxgl.Map({
    container: "map",
    style: MAPBOX_STYLES.light,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    maxZoom: 19,
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-left");
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-left");
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");

  map.on("load", function () {
    setLoading(
      true,
      "Loading census tract boundaries…",
      "Reading local GeoJSON (50 mi radius of Saratoga Springs). Run scripts/build-tracts-local.js to rebuild."
    );
    fetchGeoJsonOk(TRACT_BOUNDARIES_GEOJSON)
      .then(function (tractFc) {
        var cleanFc = {
          type: "FeatureCollection",
          features: tractFc && tractFc.features ? tractFc.features : [],
        };
        STATE.tractBase = coerceTractGeoids(cleanFc);
        rebuildTractCentroidIndex(STATE.tractBase);
        var blank = joinTracts(
          STATE.tractBase,
          Object.create(null),
          false,
          STATE.studyRadiusMiles,
          false
        );
        STATE.currentJoinedFc = blank;
        addStudyExtentLayersBeforeTracts();
        addTractLayers(blank);
        addStudyExtentLayersAfterTracts();

        var bb = bboxFromFc(STATE.tractBase);
        if (bb) {
          map.fitBounds(bb, { padding: 36, duration: 0, maxZoom: 10 });
        }

        setLoading(
          true,
          "Loading PLACES data…",
          "Using study-area file PLACES_saratoga_50mi.geojson (run npm run build:places:study if missing)."
        );
        return fetchGeoJsonOk(PLACES_GEOJSON);
      })
      .then(function (placesFc) {
        var errEl = document.getElementById("data-load-error");
        if (errEl) {
          errEl.hidden = true;
          errEl.textContent = "";
        }
        var placesClean = {
          type: "FeatureCollection",
          features: placesFc && placesFc.features ? placesFc.features : [],
        };
        STATE.placesRaw = placesClean;
        return fetch(PLACES_MANIFEST_URL)
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .catch(function () {
            return null;
          })
          .then(function (manifest) {
            STATE.placesManifest = manifest || deriveManifestFromPlaces(placesClean);
            STATE.catalogByKey = buildCatalog(placesClean);
            populateSurveyYearsDropdown();
            populateMetricDropdown();
            wireUiAfterData();
            refreshChoroplethFromSelection();
          });
      })
      .catch(function (err) {
        console.error(err);
        var msg = String(err && err.message ? err.message : err);
        var errEl = document.getElementById("data-load-error");
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent =
            "Could not load dashboard data. Check the browser console and verify files in /data exist. " +
            msg;
        }
        wireUiAfterData();
      })
      .finally(function () {
        setLoading(false);
      });
  });
})();
