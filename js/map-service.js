/**
 * MotoNav - Map Service Module
 * Hỗ trợ Google Maps JavaScript API và Leaflet (OpenStreetMap) ở Chế độ sáng (Light Mode)
 */
window.MotoNav = window.MotoNav || {};

MotoNav.map = (() => {
  const { $ } = MotoNav.utils;
  const state = MotoNav.state;

  function getStoredKey() {
    return localStorage.getItem('motonav_gkey') || '';
  }

  function saveKey(key) {
    if (!key) return;
    localStorage.setItem('motonav_gkey', key.trim());
    location.reload();
  }

  function clearKey() {
    localStorage.removeItem('motonav_gkey');
    location.reload();
  }

  // Tải động thư viện Google Maps SDK
  function loadGoogleSdk(apiKey) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,geometry&callback=__gmapsInit`;
      s.async = true;
      s.defer = true;
      window.__gmapsInit = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Khởi tạo Google Maps (Chế độ sáng sắc nét ngoài trời)
  function initGoogleMap() {
    const defaultPos = state.lastPos
      ? { lat: state.lastPos[1], lng: state.lastPos[0] }
      : { lat: 10.7769, lng: 106.7009 };

    state.gMap = new google.maps.Map($('map'), {
      center: defaultPos,
      zoom: 16,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      // Chế độ sáng: Giữ màu sắc bản đồ tự nhiên, rõ ràng dưới ánh nắng mặt trời
      styles: []
    });

    state.gDirectionsService = new google.maps.DirectionsService();
    state.gDirectionsRenderer = new google.maps.DirectionsRenderer({
      map: state.gMap,
      suppressMarkers: false,
      polylineOptions: { strokeColor: '#0284c7', strokeWeight: 6 }
    });

    // Lắng nghe sự kiện chuyển tuyến khi bấm trực tiếp vào đường trên Google Map
    state.gDirectionsRenderer.addListener('routeindex_changed', () => {
      if (state.isSelectingRoute) return;
      const idx = state.gDirectionsRenderer.getRouteIndex();
      if (typeof idx === 'number' && idx >= 0 && idx !== state.activeRouteIndex && state.availableRoutes && state.availableRoutes[idx]) {
        MotoNav.routing.selectRoute(idx);
      }
    });

    state.gUserMarker = new google.maps.Marker({
      map: state.gMap,
      position: defaultPos,
      title: 'Vị trí của bạn',
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 6,
        fillColor: '#0284c7',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
        rotation: 0
      }
    });

    // Tích hợp Google Places Autocomplete vào ô tìm kiếm
    state.gAutocomplete = new google.maps.places.Autocomplete($('q'), {
      fields: ['geometry', 'name', 'formatted_address'],
      componentRestrictions: { country: 'vn' }
    });

    state.gAutocomplete.addListener('place_changed', () => {
      const place = state.gAutocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) {
        MotoNav.utils.setMsg('Không lấy được toạ độ của địa điểm này');
        return;
      }
      const lat = place.geometry.location.lat();
      const lon = place.geometry.location.lng();
      MotoNav.search.pickDestination({
        name: place.name || place.formatted_address,
        lat, lon,
        gLocation: place.geometry.location
      });
      state.gMap.panTo(place.geometry.location);
    });
  }

  // Khởi tạo Leaflet Map (Bản đồ đường phố miễn phí, Chế độ sáng rõ nét)
  function initLeafletMap() {
    const defaultPos = state.lastPos
      ? [state.lastPos[1], state.lastPos[0]]
      : [10.7769, 106.7009];

    state.lMap = L.map('map').setView(defaultPos, 15);

    // Bản đồ đường phố Esri World Street Map (Sáng, chi tiết, không cần API Key)
    const esriLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri'
    });

    // Dự phòng OSM France HOT
    const hotBackup = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      subdomains: ['a', 'b', 'c'],
      maxZoom: 19,
      attribution: '© OpenStreetMap, OSM France'
    });

    esriLayer.on('tileerror', () => {
      if (!state.lMap.hasLayer(hotBackup)) {
        state.lMap.removeLayer(esriLayer);
        hotBackup.addTo(state.lMap);
      }
    });

    esriLayer.addTo(state.lMap);

    state.lUserMarker = L.circleMarker(defaultPos, {
      radius: 9,
      fillColor: '#0284c7',
      color: '#ffffff',
      weight: 3,
      fillOpacity: 1
    }).addTo(state.lMap);
  }

  // Khởi chạy Engine kiểm tra Key. Trả về Promise để app.js biết khi nào bản đồ sẵn sàng
  // (dùng cho việc tự khôi phục phiên dẫn đường sau khi iOS kill trang).
  function initEngine() {
    const key = getStoredKey();
    const badge = $('engineBadge');
    if (key) {
      return loadGoogleSdk(key).then(() => {
        state.mapEngine = 'google';
        if (badge) {
          badge.textContent = 'Bản đồ: Google Maps 🟢';
          badge.className = 'pill ok';
        }
        initGoogleMap();
      }).catch(err => {
        console.warn('Không tải được Google Maps SDK:', err);
        state.mapEngine = 'osm';
        if (badge) {
          badge.textContent = 'Google lỗi -> Dùng OSM 🟡';
          badge.className = 'pill warn';
        }
        initLeafletMap();
      });
    } else {
      state.mapEngine = 'osm';
      if (badge) {
        badge.textContent = 'Bản đồ: OpenStreetMap 🟡';
        badge.className = 'pill warn';
      }
      initLeafletMap();
      return Promise.resolve();
    }
  }

  // Di chuyển tâm bản đồ tới toạ độ [lon, lat]
  function panTo(coords) {
    if (state.mapEngine === 'google' && state.gMap) {
      state.gMap.panTo({ lat: coords[1], lng: coords[0] });
    } else if (state.lMap) {
      state.lMap.panTo([coords[1], coords[0]]);
    }
  }

  return {
    getStoredKey,
    saveKey,
    clearKey,
    initEngine,
    panTo
  };
})();
