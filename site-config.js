/**
 * Mapbox public token (pk.…) — https://account.mapbox.com/access-tokens/
 * Optional: set dashboardPassword to enable the login gate.
 *
 * Tracked with an empty token so GitHub Pages always loads this file (no 404).
 * Put your pk token in mapboxAccessToken below for the map, OR set it once in the
 * browser console (persists on this machine): localStorage.setItem("saratoga_mapbox_pk", "pk...."); location.reload()
 */
window.__SaratogaSiteConfig = {
  /* Paste your public Mapbox token (pk.…) here for the map; leave empty to use sidebar/charts only. */
  mapboxAccessToken: "",
  dashboardPassword: "",
};
