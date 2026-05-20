# Census tract vintage vs PLACES and ACS extracts

## Study-area polygons (`tracts_saratoga_50mi.geojson`)

The dashboard map uses **one** tract polygon layer built from Census **TIGER/Line** geometries (see `scripts/build-tracts-local.js`). Tract identifiers (`GEOID`) follow the **2020 Census** tract inventory for the counties that intersect the 50 mi study circle.

## PLACES tract rows

CDC PLACES tract features are keyed by tract **`locationname`** (GEOID). Each PLACES release documents which census vintage its geography uses. For trend charts, **keep GEOIDs aligned**: if a BRFSS year in your bundle still references **2010-defined** tracts while your polygons are **2020**, comparisons can be misleading unless you:

- restrict analysis to years or releases that match your polygon vintage, or  
- apply a **tract crosswalk** (Census relationship files or equivalent) to aggregate estimates onto your current GEOIDs.

The bundled `places_manifest.json` lists **BRFSS survey years** present in `PLACES_saratoga_50mi.geojson` and, per measure, which years appear. It does not replace CDC’s documentation—confirm geography vintage for each PLACES download you merge.

## When you need a crosswalk

Use a crosswalk if you merge **multiple PLACES releases** and CDC’s tract definitions **do not match** your single polygon layer (e.g. mixing pre–2020 tabulation tracts with a 2020 tract map). Otherwise, prefer **one vintage** of tract boundaries or separate layers per vintage.

## ACS / PEP age extracts (Phase 2)

**Full study-area counts:** The dashboard reads **`data/acs_age_by_tract.json`**. The Census Data API **requires a free API key on every request** (there is no keyless download). Run **`npm run build:acs-age`** once with `CENSUS_API_KEY` or `data/.census-api-key` set; the script replaces that file with **B01001 for every tract GEOID** in `tracts_saratoga_50mi.geojson` (typically hundreds of thousands of adults 18+ in aggregate). A tiny bundled file is only a placeholder for offline UI testing.

Tract-level age tables (e.g. ACS **B01001** collapsed into bins) must use GEOIDs consistent with the same vintage as your map layer unless you crosswalk counts. Optional population denominators (PEP or **B01003**) should use the same vintage logic.

### Rebuild `acs_age_by_tract.json` (B01001, all study tracts)

1. Request a free Census Data API key: https://api.census.gov/data/key_signup.html  
2. Either set environment variable `CENSUS_API_KEY`, or put the key alone in **`data/.census-api-key`** (that file is gitignored—see `.gitignore` in this folder).  
3. From the **Health Demographics Dashboard** directory run:

```bash
npm run build:acs-age
```

Optional flags:

```bash
node scripts/fetch-acs-age-by-tract.js --tracts data/tracts_saratoga_50mi.geojson --out data/acs_age_by_tract.json --year 2023
node scripts/fetch-acs-age-by-tract.js --years 2015-2024
```

By default the script requests ACS 5-year **end-years** 2015–2024, probes each year on the API, and skips years that are not published yet. Output is one GeoJSON feature per **tract GEOID × year**; `meta.surveyYears` / `meta.acsEndYearsIncluded` list the vintages actually written. Use `--year Y` for a single vintage only.

The script reads every tract `GEOID` in the tract GeoJSON, derives unique `(state, county)` pairs, queries ACS 5-year **B01001** estimates per county (`for=tract:*&in=state:…&in=county:…`), keeps only tracts in the study file, and writes `ageBins` (combined), `ageBinsMale`, and `ageBinsFemale` for **ages 18+** through **85+** using `scripts/b01001-tract-bin-map.js` (under-18 rows are omitted). Margins of error are not included; Census suppression appears as zero in bin sums.

## Dashboard year range (UI only)

The live dashboard uses **`MIN_DASHBOARD_YEAR = 2020`** in `app.js` for ACS end-years, BRFSS survey years, trend charts, and %‑change baselines. Older years may still exist in `acs_age_by_tract.json` and PLACES files; they are not deleted—only hidden from the UI to avoid comparing pre‑2020 ACS tract coverage with 2020+ geography.

## Loading strategy

- **Bundled multi-year PLACES**: `merge-places-sources.js` concatenates releases, then filters with `--tracts` (same pattern as `filter-places-by-tracts.js`). The app reads `places_manifest.json` for year coverage and keeps **one** tract GeoJSON so geometry is not duplicated per year.
- **Lazy-by-year** (optional): you can split outputs per survey year and fetch by selection; the current implementation assumes **one** filtered GeoJSON plus manifest.
