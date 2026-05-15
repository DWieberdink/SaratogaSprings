/**
 * ACS 5-year B01001 (Sex by Age) — tract estimate variable suffixes (…E) for dashboard bins.
 * Male suffixes 003–025; female age lines start at 027 (female “total” line is 026).
 * Female age suffix = male age suffix + 24 for paired rows (verified for 2015–2024 ACS 5-year shells).
 * Under-18 uses male rows 003–006 and female 027–030 (paired +24).
 */
var PAIRS = [
  ["under_18", [3, 4, 5, 6], [27, 28, 29, 30]],
  ["18_19", [7], [31]],
  ["20_24", [8, 9, 10], [32, 33, 34]],
  ["25_29", [11], [35]],
  ["30_34", [12], [36]],
  ["35_39", [13], [37]],
  ["40_44", [14], [38]],
  ["45_49", [15], [39]],
  ["50_54", [16], [40]],
  ["55_59", [17], [41]],
  ["60_64", [18, 19], [42, 43]],
  ["65_69", [20, 21], [44, 45]],
  ["70_74", [22], [46]],
  ["75_79", [23], [47]],
  ["80_84", [24], [48]],
  ["85_up", [25], [49]],
];

var binToVarSuffixes = Object.create(null);
var binToMaleSuffixes = Object.create(null);
var binToFemaleSuffixes = Object.create(null);
var i;
for (i = 0; i < PAIRS.length; i++) {
  var name = PAIRS[i][0];
  var m = PAIRS[i][1];
  var f = PAIRS[i][2];
  binToMaleSuffixes[name] = m.slice();
  binToFemaleSuffixes[name] = f.slice();
  binToVarSuffixes[name] = m.concat(f);
}

module.exports = {
  PAIRS: PAIRS,
  binToVarSuffixes: binToVarSuffixes,
  binToMaleSuffixes: binToMaleSuffixes,
  binToFemaleSuffixes: binToFemaleSuffixes,
};
