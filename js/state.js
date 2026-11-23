/**
 * MotoNav - Shared Application State
 */
window.MotoNav = window.MotoNav || {};

MotoNav.state = {
  // Bluetooth
  device: null,
  rxChar: null,
  lastMsg: '',
  curMsg: '',
  blePingTimer: null,
  busy: false,
  queued: null,

  // Điểm đến và dẫn đường
  dest: null,
  routeLine: [],
  steps: [],
  k: 0,
  navigating: false,
  rerouting: false,
  offCount: 0,

  // GPS & Thiết bị
  watchId: null,
  lastPos: null,
  lastGpsFix: 0,
  gpsWatchdogTimer: null,
  currentHeading: 0,
  wake: null,

  // Tuyến đường gợi ý
  availableRoutes: [],
  activeRouteIndex: 0,
  gAltPolylines: [],
  lRouteLines: [],

  // Engine Bản đồ ('google' hoặc 'osm')
  mapEngine: 'osm',
  gMap: null,
  gDirectionsService: null,
  gDirectionsRenderer: null,
  gUserMarker: null,
  gAutocomplete: null,
  lMap: null,
  lUserMarker: null,
  lDestMarker: null
};
