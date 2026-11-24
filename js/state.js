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
  bleConnected: false,
  bleConnecting: false,

  // Điểm đến và dẫn đường
  dest: null,
  routeLine: [],
  steps: [],
  k: 0,
  navigating: false,
  rerouting: false,
  offCount: 0,
  arrived: false,

  // Lộ trình nạp trước xuống BW16 (chế độ offline khi tắt màn hình)
  plan: null,
  planBaseK: 0,
  planSeqSent: 0,

  // Khôi phục phiên sau khi iOS/Bluefy kill trang
  pendingResume: false,
  lastSessionSave: 0,

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
  isSelectingRoute: false,
  rerouteGraceUntil: 0,

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
