/**
 * Build data/acs_age_by_tract.json from Census ACS 5-year B01001 (Sex by Age) at tract level
 * for all GEOIDs in tracts_saratoga_50mi.geojson (or another tract FeatureCollection).
 *
 * Usage (from Health Demographics Dashboard folder):
 *   npm run build:acs-age
 *
 * Optional:
 *   node scripts/fetch-acs-age-by-tract.js [--tracts data/tracts_saratoga_50mi.geojson] [--out data/acs_age_by_tract.json]
 *   node scripts/fetch-acs-age-by-tract.js --years 2015-2024
 *   node scripts/fetch-acs-age-by-tract.js --year 2022
 *
 * Default: tries ACS 5-year end-years 2015–2024 (skips any year the API does not publish).
 * Output: one Feature per (tract GEOID × year) with properties GEOID, year, ageBins, ageBinsMale, ageBinsFemale.
 *
 * Optional: set CENSUS_API_KEY or data/.census-api-key (see .gitignore).
 */

/* eslint-disable no-console */
var fs = require("fs");
var path = require("path");
var binMap = require("./b01001-tract-bin-map.js");

function defaultEndYears() {
  var out = [];
  var y;
  for (y = 2015; y <= 2024; y++) {
    out.push(y);
  }
  return out;
}

function parseYearsSpec(s) {
  s = String(s).trim();
  if (s.indexOf("-") >= 0) {
    var parts = s.split("-").map(function (x) {
      return parseInt(x.trim(), 10);
    });
    if (parts.length !== 2 || !isFinite(parts[0]) || !isFinite(parts[1])) return null;
    var lo = Math.min(parts[0], parts[1]);
    var hi = Math.max(parts[0], parts[1]);
    var out = [];
    var y;
    for (y = lo; y <= hi; y++) {
      out.push(y);
    }
    return out;
  }
  return s.split(",").map(function (x) {
    return parseInt(x.trim(), 10);
  }).filter(function (y) {
    return isFinite(y);
  });
}

function parseArgs(argv) {
  var out = {
    tractsPath: path.join(__dirname, "..", "data", "tracts_saratoga_50mi.geojson"),
    outPath: path.join(__dirname, "..", "data", "acs_age_by_tract.json"),
    years: null,
    singleYear: null,
  };
  var i;
  for (i = 2; i < argv.length; i++) {
    if (argv[i] === "--tracts" && argv[i + 1]) {
      out.tractsPath = path.resolve(process.cwd(), argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out.outPath = path.resolve(process.cwd(), argv[++i]);
    } else if (argv[i] === "--years" && argv[i + 1]) {
      out.years = parseYearsSpec(argv[++i]);
    } else if (argv[i] === "--year" && argv[i + 1]) {
      out.singleYear = parseInt(argv[++i], 10);
    }
  }
  if (out.singleYear != null && isFinite(out.singleYear)) {
    out.years = [out.singleYear];
  } else if (!out.years || !out.years.length) {
    out.years = defaultEndYears();
  }
  if (!out.years || !out.years.length) {
    out.years = defaultEndYears();
  }
  var uniq = [];
  var seen = Object.create(null);
  var yi;
  for (yi = 0; yi < out.years.length; yi++) {
    var yy = out.years[yi];
    if (!isFinite(yy) || seen[yy]) continue;
    seen[yy] = true;
    uniq.push(yy);
  }
  uniq.sort(function (a, b) {
    return a - b;
  });
  out.years = uniq;
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function collectGeoidsAndCounties(tractFc) {
  var allowed = Object.create(null);
  var counties = Object.create(null);
  var feats = tractFc && tractFc.features ? tractFc.features : [];
  var fi;
  for (fi = 0; fi < feats.length; fi++) {
    var p = feats[fi].properties || {};
    var gid = p.GEOID != null ? String(p.GEOID).trim() : "";
    if (!gid || gid.length < 11) continue;
    allowed[gid] = true;
    var st = gid.slice(0, 2);
    var co = gid.slice(2, 5);
    counties[st + "|" + co] = { state: st, county: co };
  }
  var countyList = Object.keys(counties).map(function (k) {
    return counties[k];
  });
  countyList.sort(function (a, b) {
    if (a.state !== b.state) return a.state.localeCompare(b.state);
    return a.county.localeCompare(b.county);
  });
  return { allowed: allowed, countyList: countyList };
}

function uniqueVarSuffixes() {
  var set = Object.create(null);
  var bk;
  for (bk in binMap.binToVarSuffixes) {
    if (!Object.prototype.hasOwnProperty.call(binMap.binToVarSuffixes, bk)) continue;
    var arr = binMap.binToVarSuffixes[bk];
    var j;
    for (j = 0; j < arr.length; j++) {
      set[arr[j]] = true;
    }
  }
  return Object.keys(set)
    .map(Number)
    .sort(function (a, b) {
      return a - b;
    });
}

function buildVariableList() {
  var suf = uniqueVarSuffixes();
  var parts = [];
  var i;
  for (i = 0; i < suf.length; i++) {
    parts.push("B01001_" + pad3(suf[i]) + "E");
  }
  return parts.join(",");
}

function httpsGetJson(url) {
  return fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "SaratogaHealthDash/1.0 (tract ACS fetch; census ACS5 B01001)",
      Accept: "application/json",
    },
  }).then(function (res) {
    return res.text().then(function (text) {
      if (!res.ok) {
        throw new Error("HTTP " + res.status + ": " + text.slice(0, 400));
      }
      var t = text.trim();
      if (t.charAt(0) === "<") {
        throw new Error(
          "Census API returned HTML (invalid or missing API key?). First line: " +
            t.split(/\r?\n/)[0].slice(0, 200)
        );
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("Invalid JSON from Census API: " + text.slice(0, 200));
      }
    });
  });
}

function loadApiKey() {
  var k = (process.env.CENSUS_API_KEY || "").trim();
  if (k) return k;
  var p = path.join(__dirname, "..", "data", ".census-api-key");
  try {
    var raw = fs.readFileSync(p, "utf8");
    var lines = raw.split(/\r?\n/);
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.length > 0) return line;
    }
    return "";
  } catch (e) {
    return "";
  }
}

function parseAcsRows(json) {
  if (!json || !json.length || !Array.isArray(json[0])) return { col: {}, rows: [] };
  var headers = json[0];
  var col = Object.create(null);
  var hi;
  for (hi = 0; hi < headers.length; hi++) {
    col[headers[hi]] = hi;
  }
  var rows = [];
  var ri;
  for (ri = 1; ri < json.length; ri++) {
    rows.push(json[ri]);
  }
  return { col: col, rows: rows };
}

function numCell(row, col, key) {
  var idx = col[key];
  if (idx == null) return 0;
  var v = row[idx];
  if (v == null || v === "") return 0;
  var n = parseInt(String(v), 10);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

function rowGeoid11(row, col) {
  var st = row[col["state"]];
  var co = row[col["county"]];
  var tr = row[col["tract"]];
  if (st == null || co == null || tr == null) return "";
  var trRaw = String(tr).replace(/\./g, "");
  return String(st).padStart(2, "0") + String(co).padStart(3, "0") + trRaw.padStart(6, "0");
}

function binsFromRow(row, col) {
  var ageBins = Object.create(null);
  var ageBinsMale = Object.create(null);
  var ageBinsFemale = Object.create(null);
  var bk;
  for (bk in binMap.binToMaleSuffixes) {
    if (!Object.prototype.hasOwnProperty.call(binMap.binToMaleSuffixes, bk)) continue;
    var sm = 0;
    var sf = 0;
    var j;
    var mSuf = binMap.binToMaleSuffixes[bk];
    for (j = 0; j < mSuf.length; j++) {
      sm += numCell(row, col, "B01001_" + pad3(mSuf[j]) + "E");
    }
    var fSuf = binMap.binToFemaleSuffixes[bk];
    for (j = 0; j < fSuf.length; j++) {
      sf += numCell(row, col, "B01001_" + pad3(fSuf[j]) + "E");
    }
    ageBinsMale[bk] = sm;
    ageBinsFemale[bk] = sf;
    ageBins[bk] = sm + sf;
  }
  return { ageBins: ageBins, ageBinsMale: ageBinsMale, ageBinsFemale: ageBinsFemale };
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function probeYear(endYear, sampleCounty, apiKey) {
  var url =
    "https://api.census.gov/data/" +
    endYear +
    "/acs/acs5?get=NAME,B01001_001E&for=tract:*&in=state:" +
    sampleCounty.state +
    "&in=county:" +
    sampleCounty.county +
    "&key=" +
    encodeURIComponent(apiKey);
  return httpsGetJson(url).then(
    function () {
      return true;
    },
    function () {
      return false;
    }
  );
}

function fetchYearForAllCounties(endYear, countyList, varList, allowed, apiKey) {
  var byGeoid = Object.create(null);
  var base =
    "https://api.census.gov/data/" +
    endYear +
    "/acs/acs5?get=NAME," +
    varList +
    "&for=tract:*&in=state:%STATE%&in=county:%COUNTY%";
  return (async function () {
    var ci;
    for (ci = 0; ci < countyList.length; ci++) {
      var sc = countyList[ci];
      var url =
        base.replace("%STATE%", sc.state).replace("%COUNTY%", sc.county) +
        "&key=" +
        encodeURIComponent(apiKey);
      process.stdout.write("  " + endYear + " " + sc.state + "/" + sc.county + " … ");
      var json = await httpsGetJson(url);
      var parsed = parseAcsRows(json);
      var kept = 0;
      var ri;
      for (ri = 0; ri < parsed.rows.length; ri++) {
        var row = parsed.rows[ri];
        var gid = rowGeoid11(row, parsed.col);
        if (!gid || !allowed[gid]) continue;
        var b = binsFromRow(row, parsed.col);
        byGeoid[gid] = {
          GEOID: gid,
          year: endYear,
          ageBins: b.ageBins,
          ageBinsMale: b.ageBinsMale,
          ageBinsFemale: b.ageBinsFemale,
        };
        kept++;
      }
      console.log("rows " + parsed.rows.length + ", in study " + kept);
      if (ci + 1 < countyList.length) await sleep(250);
    }
    return byGeoid;
  })();
}

function main() {
  var args = parseArgs(process.argv);
  var apiKey = loadApiKey();
  if (!apiKey) {
    console.error(
      "Missing Census API key. Set environment variable CENSUS_API_KEY or create data/.census-api-key (one line; file is gitignored).\n" +
        "Sign up: https://api.census.gov/data/key_signup.html\n" +
        "Then: npm run build:acs-age"
    );
    process.exit(1);
  }

  var varList = buildVariableList();
  var tractFc = readJson(args.tractsPath);
  var geo = collectGeoidsAndCounties(tractFc);
  var allowed = geo.allowed;
  var countyList = geo.countyList;
  if (!countyList.length) {
    console.error("No counties derived from tract file.");
    process.exit(1);
  }

  console.log(
    "Tracts:",
    Object.keys(allowed).length,
    "| Counties:",
    countyList.length,
    "| Requested ACS end-years:",
    args.years.join(", ")
  );

  (async function () {
    var availableYears = [];
    var yi;
    for (yi = 0; yi < args.years.length; yi++) {
      var y = args.years[yi];
      process.stdout.write("Probing ACS " + y + " … ");
      var ok = await probeYear(y, countyList[0], apiKey);
      if (ok) {
        console.log("ok");
        availableYears.push(y);
      } else {
        console.log("skip (not published or error)");
      }
    }

    if (!availableYears.length) {
      console.error("No ACS 5-year vintages returned data. Check years and API key.");
      process.exit(1);
    }

    var byGeoidYear = Object.create(null);
    function setCell(gid, year, props) {
      if (!byGeoidYear[gid]) byGeoidYear[gid] = Object.create(null);
      byGeoidYear[gid][year] = props;
    }

    for (yi = 0; yi < availableYears.length; yi++) {
      var yr = availableYears[yi];
      console.log("Fetching full B01001 for ACS " + yr + " …");
      var partial = await fetchYearForAllCounties(yr, countyList, varList, allowed, apiKey);
      var gk;
      for (gk in partial) {
        if (!Object.prototype.hasOwnProperty.call(partial, gk)) continue;
        setCell(gk, yr, partial[gk]);
      }
      if (yi + 1 < availableYears.length) await sleep(400);
    }

    var surveyDesc = availableYears
      .slice()
      .sort(function (a, b) {
        return b - a;
      })
      .join(", ");

    var features = [];
    var sortedGids = Object.keys(allowed).sort();
    var yearsDesc = availableYears.slice().sort(function (a, b) {
      return b - a;
    });
    var gi;
    for (gi = 0; gi < sortedGids.length; gi++) {
      var gid = sortedGids[gi];
      var yi2;
      for (yi2 = 0; yi2 < yearsDesc.length; yi2++) {
        var yv = yearsDesc[yi2];
        var cell = byGeoidYear[gid] && byGeoidYear[gid][yv];
        if (!cell) continue;
        features.push({
          type: "Feature",
          properties: {
            GEOID: cell.GEOID,
            year: cell.year,
            ageBins: cell.ageBins,
            ageBinsMale: cell.ageBinsMale,
            ageBinsFemale: cell.ageBinsFemale,
          },
          geometry: null,
        });
      }
    }

    var out = {
      meta: {
        tractVintage: "2020",
        acsProduct: "ACS 5-Year Estimates",
        acsEndYearsIncluded: availableYears.slice().sort(function (a, b) {
          return b - a;
        }),
        sourceTable: "B01001",
        bundleKind: "full",
        tractCountInSource: sortedGids.length,
        description:
          "Tract-level population by fine age bin from ACS 5-year table B01001 (includes under-18 and 18+ detail; male + female combined in ageBins; sex splits in ageBinsMale / ageBinsFemale). GEOIDs match " +
          path.basename(args.tractsPath) +
          ". End-years included: " +
          surveyDesc +
          ".",
        surveyYears: availableYears.slice().sort(function (a, b) {
          return b - a;
        }),
        generatedAt: new Date().toISOString(),
        script: "scripts/fetch-acs-age-by-tract.js",
      },
      type: "FeatureCollection",
      features: features,
    };

    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, JSON.stringify(out, null, 2), "utf8");
    console.log("Wrote", args.outPath, "features:", features.length, "(tracts × years with data)");
  })();
}

main();
