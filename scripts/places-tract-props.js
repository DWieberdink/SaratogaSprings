/**
 * Canonical census tract GEOID from PLACES feature properties (CDC naming varies).
 */

function geoidFromPlacesProps(p) {
  if (!p) return null;
  var v =
    p.locationname != null
      ? p.locationname
      : p.LocationName != null
        ? p.LocationName
        : p.locationid != null
          ? p.locationid
          : p.LocationId != null
            ? p.LocationId
            : p.TractID != null
              ? p.TractID
              : p.tractid != null
                ? p.tractid
                : p.GEOID != null
                  ? p.GEOID
                  : p.geoid != null
                    ? p.geoid
                    : null;
  return v != null ? String(v).trim() : null;
}

/**
 * Ensures LocationName / locationname / location ids match the tract GEOID used for joins.
 */
function normalizeTractLocationProps(props, canonicalGeoid) {
  var p = Object.assign({}, props);
  if (!canonicalGeoid) return p;
  p.LocationName = canonicalGeoid;
  p.locationname = canonicalGeoid;
  if (p.locationid == null || String(p.locationid).trim() === "") {
    p.locationid = canonicalGeoid;
  }
  if (p.LocationId == null || String(p.LocationId).trim() === "") {
    p.LocationId = canonicalGeoid;
  }
  return p;
}

module.exports = {
  geoidFromPlacesProps: geoidFromPlacesProps,
  normalizeTractLocationProps: normalizeTractLocationProps,
};
