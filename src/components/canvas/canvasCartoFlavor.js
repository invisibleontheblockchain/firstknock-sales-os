// Canvas basemap theme, styled after the standard OpenStreetMap "Carto" look.
//
// Self-hosted PMTiles are vector, so the palette lives here in the app instead
// of being baked into raster images by a provider. That is what makes the
// basemap cost flat: one archive in object storage serves any number of reps
// with no per-tile meter.
//
// Colors are taken from the OSM Carto stylesheet so the field map reads the way
// reps expect: pale land, blue water, green parks/woodland, and a warm road
// hierarchy (red motorways -> orange primaries -> yellow secondaries -> white
// residential streets) that stays legible at door-knocking zooms.
//
// Key names are fixed by protomaps-leaflet's flavor contract; every key is
// filled so no feature falls back to an undefined color.
export const CANVAS_CARTO_FLAVOR = Object.freeze({
  background: '#f2efe9',
  earth: '#f2efe9',

  // Land use / natural areas
  park_a: '#c8facc',
  park_b: '#a9dfa9',
  wood_a: '#c8dfb4',
  wood_b: '#add19e',
  scrub_a: '#d6e3bc',
  scrub_b: '#c8d7ab',
  hospital: '#ffeaea',
  industrial: '#ebdbe8',
  school: '#ffffe5',
  pedestrian: '#ededea',
  glacier: '#ffffff',
  sand: '#f5e9c6',
  beach: '#fff1ba',
  aerodrome: '#e9e7e2',
  runway: '#dcdcdc',
  zoo: '#e9dfd5',
  military: '#f3e6e6',
  water: '#aad3df',

  // Buildings
  buildings: '#d9d0c9',

  // Road hierarchy — Carto's warm ramp, each with a slightly darker casing
  highway: '#e892a2',
  highway_casing_early: '#d4788a',
  highway_casing_late: '#d4788a',
  major: '#fcd6a4',
  major_casing_early: '#e0a970',
  major_casing_late: '#e0a970',
  link: '#fcd6a4',
  link_casing: '#e0a970',
  minor_a: '#f7fabf',
  minor_b: '#ffffff',
  minor_casing: '#c8c4bd',
  minor_service: '#f5f2ec',
  minor_service_casing: '#d5d1ca',
  other: '#f5f2ec',
  pier: '#eae7e0',

  // Tunnels read as muted versions of the surface network
  tunnel_highway: '#f2c4cd',
  tunnel_highway_casing: '#ddb0b8',
  tunnel_major: '#fbe6cb',
  tunnel_major_casing: '#e3cba8',
  tunnel_link: '#fbe6cb',
  tunnel_link_casing: '#e3cba8',
  tunnel_minor: '#f2efe9',
  tunnel_minor_casing: '#d5d1ca',
  tunnel_other: '#f2efe9',
  tunnel_other_casing: '#d5d1ca',

  // Bridges mirror the surface colors on a firmer casing
  bridges_highway: '#e892a2',
  bridges_highway_casing: '#c96b7d',
  bridges_major: '#fcd6a4',
  bridges_major_casing: '#d69a5e',
  bridges_link: '#fcd6a4',
  bridges_link_casing: '#d69a5e',
  bridges_minor: '#ffffff',
  bridges_minor_casing: '#bab6af',
  bridges_other: '#f5f2ec',
  bridges_other_casing: '#bab6af',

  railway: '#96a1a8',
  // Carto draws administrative borders as a violet dashed line.
  boundaries: '#c26bc2',

  // Labels: dark ink on a land-colored halo so text stays readable over parks
  roads_label_minor: '#5a5a5a',
  roads_label_minor_halo: '#ffffff',
  roads_label_major: '#3d3d3d',
  roads_label_major_halo: '#ffffff',
  address_label: '#6b6b6b',
  address_label_halo: '#ffffff',
  ocean_label: '#4a80a8',
  subplace_label: '#5c5c5c',
  subplace_label_halo: '#f2efe9',
  city_label: '#333333',
  city_label_halo: '#f2efe9',
  state_label: '#7a7a7a',
  state_label_halo: '#f2efe9',
  country_label: '#5a5a5a',

  pois: {
    blue: '#1A8CBD',
    green: '#20834D',
    lapis: '#315BCF',
    pink: '#EF56BA',
    red: '#F2567A',
    slategray: '#6A5B8F',
    tangerine: '#CB6704',
    turquoise: '#00C3D4',
  },

  landcover: {
    grassland: '#cdebb0',
    barren: '#eee5dc',
    urban_area: '#e8e4e0',
    farmland: '#eef0d5',
    glacier: '#ffffff',
    scrub: '#c8d7ab',
    forest: '#add19e',
  },
});