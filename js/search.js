/**
 * MotoNav - Search & Geocoding Module
 * Tìm kiếm địa chỉ qua Photon API, OpenStreetMap Nominatim và Google Geocoder
 */
window.MotoNav = window.MotoNav || {};

MotoNav.search = (() => {
  const { $, setMsg } = MotoNav.utils;
  const state = MotoNav.state;
  let suggestTimer = null;

  // Chọn điểm đến
  function pickDestination(d) {
    state.dest = d;
    const resBox = $('results');
    if (resBox) resBox.innerHTML = '';
    const pickedEl = $('picked');
    if (pickedEl) pickedEl.textContent = 'Điểm đến: ' + d.name;

    setMsg('Đã chọn điểm đến. Đang tìm các tuyến đường…');

    if (state.mapEngine === 'google' && state.gMap) {
      const pt = d.gLocation || new google.maps.LatLng(d.lat, d.lon);
      state.gMap.panTo(pt);
    } else if (state.lMap) {
      if (state.lDestMarker) state.lMap.removeLayer(state.lDestMarker);
      state.lDestMarker = L.marker([d.lat, d.lon]).addTo(state.lMap).bindPopup(d.name).openPopup();
      state.lMap.panTo([d.lat, d.lon]);
    }

    // Tự động tìm lộ trình nếu đã có vị trí GPS hiện tại
    if (state.lastPos) {
      MotoNav.routing.buildRoute(state.lastPos).then(() => {
        setMsg('Đã tìm thấy các gợi ý tuyến đường. Chọn tuyến và bấm "Bắt đầu dẫn đường".');
      }).catch(err => {
        setMsg('Lỗi tìm đường: ' + err.message);
      });
    } else {
      setMsg('Đã chọn điểm đến. Bấm "Bắt đầu dẫn đường".');
    }
  }

  // Hiển thị danh sách gợi ý khi gõ tìm kiếm
  function renderOsmSuggestions(items) {
    const box = $('results');
    if (!box) return;
    box.innerHTML = '';
    if (!items || !items.length) {
      box.innerHTML = '<div class="mut" style="padding:8px 4px;">Không tìm thấy địa điểm phù hợp</div>';
      return;
    }
    items.forEach(it => {
      const div = document.createElement('div');
      div.className = 'res';
      div.innerHTML = `
        <span class="res-icon">📍</span>
        <div class="res-body">
          <div class="res-title">${it.title}</div>
          <div class="res-sub">${it.sub || it.fullName}</div>
        </div>
      `;
      div.onclick = () => {
        const qInput = $('q');
        if (qInput) qInput.value = it.title;
        pickDestination({
          name: it.fullName,
          lat: it.lat,
          lon: it.lon,
          gLocation: window.google ? new google.maps.LatLng(it.lat, it.lon) : null
        });
        box.innerHTML = '';
      };
      box.appendChild(div);
    });
  }

  // Tìm kiếm gợi ý thời gian thực qua Photon & Nominatim
  async function fetchOsmSuggestions(q) {
    if (!q || q.length < 2) {
      const box = $('results');
      if (box) box.innerHTML = '';
      return;
    }

    // 1. Photon Komoot API (nhanh, dữ liệu OSM toàn cầu)
    try {
      let biasParam = '';
      if (state.lastPos) biasParam = `&lat=${state.lastPos[1]}&lon=${state.lastPos[0]}`;
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6${biasParam}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.features && data.features.length) {
        const items = data.features.map(f => {
          const p = f.properties;
          const coords = f.geometry.coordinates; // [lon, lat]
          const title = p.name || (p.housenumber ? p.housenumber + ' ' : '') + (p.street || 'Địa điểm');
          const parts = [p.housenumber, p.street, p.district, p.city || p.state, p.country].filter(Boolean);
          const sub = parts.length ? parts.join(', ') : (p.county || p.country || '');
          return {
            title, sub,
            fullName: title + (sub ? ', ' + sub : ''),
            lat: coords[1],
            lon: coords[0]
          };
        });
        renderOsmSuggestions(items);
        return;
      }
    } catch (err) {
      console.warn('Photon error, fallback to Nominatim:', err);
    }

    // 2. Dự phòng OpenStreetMap Nominatim
    try {
      const bias = state.lastPos ? `&viewbox=${state.lastPos[0] - .6},${state.lastPos[1] + .6},${state.lastPos[0] + .6},${state.lastPos[1] - .6}` : '';
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=vi&q=${encodeURIComponent(q)}${bias}`);
      const list = await r.json();
      if (list && list.length) {
        const items = list.map(it => {
          const parts = it.display_name.split(',');
          const title = parts[0].trim();
          const sub = parts.slice(1).join(',').trim();
          return {
            title, sub,
            fullName: it.display_name,
            lat: +it.lat,
            lon: +it.lon
          };
        });
        renderOsmSuggestions(items);
      } else {
        const box = $('results');
        if (box) box.innerHTML = '<div class="mut" style="padding:8px 4px;">Không tìm thấy địa điểm</div>';
      }
    } catch (e) {
      console.warn('Nominatim error:', e);
    }
  }

  // Kích hoạt tìm kiếm thủ công (nút Tìm kiếm hoặc phím Enter)
  async function performSearch() {
    const qInput = $('q');
    if (!qInput) return;
    const q = qInput.value.trim();
    if (!q) return;

    // Toạ độ dạng "10.7769, 106.7009"
    const mCoord = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (mCoord) {
      const lat = +mCoord[1], lon = +mCoord[2];
      pickDestination({
        name: `Toạ độ ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        lat, lon,
        gLocation: window.google ? new google.maps.LatLng(lat, lon) : null
      });
      return;
    }

    // Link Google Maps dạng @lat,lon hoặc query=lat,lon
    const mUrl = q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || q.match(/[?&](?:q|query)=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (mUrl) {
      const lat = +mUrl[1], lon = +mUrl[2];
      pickDestination({
        name: `Vị trí từ Google Maps (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
        lat, lon,
        gLocation: window.google ? new google.maps.LatLng(lat, lon) : null
      });
      return;
    }

    setMsg('Đang tìm kiếm…');

    // Chế độ Google Maps: Geocoder
    if (state.mapEngine === 'google' && window.google && google.maps && google.maps.Geocoder) {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: q, componentRestrictions: { country: 'VN' } }, (results, status) => {
        const box = $('results');
        if (box) box.innerHTML = '';
        if (status === 'OK' && results && results.length) {
          results.slice(0, 5).forEach(it => {
            const div = document.createElement('div');
            div.className = 'res';
            div.innerHTML = `
              <span class="res-icon">📍</span>
              <div class="res-body">
                <div class="res-title">${it.formatted_address.split(',')[0]}</div>
                <div class="res-sub">${it.formatted_address}</div>
              </div>
            `;
            div.onclick = () => {
              const loc = it.geometry.location;
              pickDestination({
                name: it.formatted_address,
                lat: loc.lat(),
                lon: loc.lng(),
                gLocation: loc
              });
            };
            if (box) box.appendChild(div);
          });
          setMsg('Chọn một kết quả của Google bên dưới');
        } else {
          setMsg('Google Maps không tìm thấy địa chỉ này. Thử gõ rõ hơn.');
        }
      });
      return;
    }

    // Chế độ OpenStreetMap
    fetchOsmSuggestions(q);
  }

  function onInput(val) {
    if (state.mapEngine === 'google') return;
    clearTimeout(suggestTimer);
    if (!val || val.length < 2) {
      const box = $('results');
      if (box) box.innerHTML = '';
      return;
    }
    suggestTimer = setTimeout(() => {
      fetchOsmSuggestions(val);
    }, 280);
  }

  return {
    pickDestination,
    performSearch,
    onInput
  };
})();
