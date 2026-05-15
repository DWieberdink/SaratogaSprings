/**
 * Mapbox public token (pk.…) — https://account.mapbox.com/access-tokens/
 * Optional: set dashboardPassword to enable the login gate.
 *
 * GitHub blocks pushing a real pk token in this file. For the map locally, set mapboxAccessToken
 * below, or use: localStorage.setItem("saratoga_mapbox_pk","pk...."); location.reload()
 * For GitHub Pages, use the same localStorage line in the browser once per device.
 */
window.__SaratogaSiteConfig = {
  mapboxAccessToken: "",
  dashboardPassword: "",
};
