/**
 * MotoNav - Multi-Route Suggestion & Calculation Module
 * Tính toán nhiều lựa chọn lộ trình và hiển thị thẻ chọn tuyến (Google Maps & OSRM)
 */
window.MotoNav = window.MotoNav || {};

MotoNav.routing = (() => {
  const { $, fmt, setMsg } = MotoNav.utils;
  const state = MotoNav.state;

  // Xoá các đường vẽ phụ khi đổi điểm đến hoặc tính lại lộ trình
  function clearAltRoutes() {
    if (state.gAltPolylines && state.gAltPolylines.length) {
      state.gAltPolylines.forEach(p => p.setMap(null));
      state.gAltPolylines = [];
    }
    if (state.lRouteLines && state.lRouteLines.length) {
      state.lRouteLines.forEach(l => state.lMap.removeLayer(l));
      state.lRouteLines = [];
    }
  }

  // Vẽ các thẻ gợi ý tuyến đường (Route Cards)
  function renderRouteCards() {
    const box = $('routeBox');
    const list = $('routeList');
    const countSpan = $('routeCount');
    if (!box || !list) return;

    if (!state.availableRoutes || state.availableRoutes.length === 0) {
      box.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    box.style.display = 'block';
    if (countSpan) countSpan.textContent = state.availableRoutes.length + ' tuyến';

    let html = '';
    const minDur = Math.min(...state.availableRoutes.map(r => r.durationValue || 0));

    state.availableRoutes.forEach((r, idx) => {
      const isSel = (idx === state.activeRouteIndex);
      const diffSec = (r.durationValue || 0) - minDur;
      const diffMin = Math.round(diffSec / 60);
      const tag = (diffSec <= 45)
        ? '<span class="route-tag">Nhanh nhất</span>'
        : `<span class="pill" style="font-size:11px; padding:2px 7px;">+${diffMin} phút</span>`;

      html += `
        <div class="route-opt ${isSel ? 'active' : ''}" onclick="MotoNav.routing.selectRoute(${idx})">
          <div class="route-opt-top">
            <div>
              <span class="route-time">${r.durationText}</span>
              <span class="route-dist">(${r.distanceText})</span>
            </div>
            ${tag}
          </div>
          <div class="route-via">${r.summary || ('Tuyến số ' + (idx + 1))}</div>
        </div>
      `;
    });
    list.innerHTML = html;
  }

  // Vẽ các tuyến thay thế màu xám trên Google Maps để người dùng bấm chọn trực quan
  function drawGoogleAltPolylines() {
    if (state.gAltPolylines && state.gAltPolylines.length) {
      state.gAltPolylines.forEach(p => p.setMap(null));
      state.gAltPolylines = [];
    }
    if (!state.availableRoutes || state.availableRoutes.length <= 1) return;

    state.availableRoutes.forEach((r, idx) => {
      if (idx === state.activeRouteIndex) return; // Tuyến chính do DirectionsRenderer phụ trách
      const poly = new google.maps.Polyline({
        path: r.overview_path,
        map: state.gMap,
        strokeColor: '#94a3b8',
        strokeOpacity: 0.7,
        strokeWeight: 5,
        zIndex: 5
      });
      poly.addListener('click', () => {
        selectRoute(idx);
      });
      state.gAltPolylines.push(poly);
    });
  }

  // Chuyển sang tuyến đường được chọn (từ danh sách hoặc chạm trên bản đồ)
  function selectRoute(idx) {
    if (!state.availableRoutes || !state.availableRoutes[idx]) return;
    state.activeRouteIndex = idx;
    const cur = state.availableRoutes[idx];

    if (state.mapEngine === 'google') {
      if (state.gDirectionsRenderer) {
        state.gDirectionsRenderer.setRouteIndex(idx);
      }
      drawGoogleAltPolylines();
      state.routeLine = cur.overview_path.map(p => [p.lng(), p.lat()]);
      state.steps = cur.steps;
    } else {
      state.routeLine = cur.coordinates;
      state.steps = cur.steps;
      if (state.lRouteLines && state.lRouteLines.length) {
        state.lRouteLines.forEach((poly, i) => {
          const isSel = (i === idx);
          poly.setStyle({
            color: isSel ? '#0284c7' : '#94a3b8',
            weight: isSel ? 6 : 4,
            opacity: isSel ? 0.95 : 0.6
          });
          if (isSel) poly.bringToFront();
        });
      }
    }

    state.k = 0;
    state.offCount = 0;
    renderRouteCards();

    if (state.navigating) {
      setMsg('Đã chuyển điều hướng sang: ' + (cur.summary || `Tuyến ${idx + 1}`));
      if (state.lastPos) {
        MotoNav.navigation.updateNavGuidance(state.lastPos);
      }
    }
  }

  // Tính toán lộ trình qua Google Maps Directions API
  async function buildRouteGoogle(from, isReroute) {
    const origin = new google.maps.LatLng(from[1], from[0]);
    const destination = state.dest.gLocation || new google.maps.LatLng(state.dest.lat, state.dest.lon);

    return new Promise((resolve, reject) => {
      state.gDirectionsService.route({
        origin, destination,
        travelMode: google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: true
      }, (result, status) => {
        if (status === google.maps.DirectionsStatus.OK) {
          clearAltRoutes();
          state.availableRoutes = result.routes.map((rt, idx) => {
            const leg = rt.legs[0];
            return {
              raw: rt,
              durationText: leg.duration ? leg.duration.text : '',
              durationValue: leg.duration ? leg.duration.value : 0,
              distanceText: leg.distance ? leg.distance.text : '',
              distanceValue: leg.distance ? leg.distance.value : 0,
              summary: rt.summary ? ('Qua ' + rt.summary) : (leg.steps && leg.steps[0] ? ('Qua ' + MotoNav.navigation.streetFromGoogleStep(leg.steps[0])) : ('Tuyến ' + (idx + 1))),
              overview_path: rt.overview_path,
              steps: leg.steps
            };
          });

          state.activeRouteIndex = 0;
          state.gDirectionsRenderer.setDirections(result);
          state.gDirectionsRenderer.setRouteIndex(state.activeRouteIndex);

          drawGoogleAltPolylines();

          const curRoute = state.availableRoutes[state.activeRouteIndex];
          state.routeLine = curRoute.overview_path.map(p => [p.lng(), p.lat()]);
          state.steps = curRoute.steps;
          state.k = 0;
          state.offCount = 0;

          renderRouteCards();
          resolve();
        } else {
          reject(new Error('Google Maps không tìm được đường: ' + status));
        }
      });
    });
  }

  // Tính toán lộ trình qua OpenStreetMap OSRM API
  async function buildRouteOsm(from, isReroute) {
    const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${state.dest.lon},${state.dest.lat}?alternatives=true&steps=true&geometries=geojson&overview=full`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes.length) {
      throw new Error(j.message || 'Không tìm thấy đường');
    }

    clearAltRoutes();
    state.availableRoutes = j.routes.map((rt, idx) => {
      const durSec = Math.round(rt.duration || 0);
      const durMin = Math.round(durSec / 60);
      const durText = durMin >= 60 ? `${Math.floor(durMin / 60)} giờ ${durMin % 60} p` : `${durMin} phút`;

      let summary = '';
      if (rt.legs && rt.legs[0]) {
        if (rt.legs[0].summary) {
          summary = 'Qua ' + rt.legs[0].summary;
        } else {
          const names = rt.legs[0].steps.map(s => s.name).filter(n => n && n.length > 2);
          const unique = [...new Set(names)].slice(0, 2);
          summary = unique.length ? ('Qua ' + unique.join(', ')) : ('Tuyến ' + (idx + 1));
        }
      }

      return {
        coordinates: rt.geometry.coordinates,
        steps: rt.legs[0].steps,
        durationText: durText,
        durationValue: durSec,
        distanceText: fmt(rt.distance),
        distanceValue: rt.distance,
        summary
      };
    });

    state.activeRouteIndex = 0;
    const curRoute = state.availableRoutes[state.activeRouteIndex];
    state.routeLine = curRoute.coordinates;
    state.steps = curRoute.steps;
    state.k = 0;
    state.offCount = 0;

    if (state.lMap) {
      state.lRouteLines = state.availableRoutes.map((r, idx) => {
        const isSel = (idx === state.activeRouteIndex);
        const latlngs = r.coordinates.map(c => [c[1], c[0]]);
        const poly = L.polyline(latlngs, {
          color: isSel ? '#0284c7' : '#94a3b8',
          weight: isSel ? 6 : 4,
          opacity: isSel ? 0.95 : 0.6
        }).addTo(state.lMap);

        poly.on('click', () => {
          selectRoute(idx);
        });
        return poly;
      });

      if (state.lRouteLines[state.activeRouteIndex]) {
        state.lRouteLines[state.activeRouteIndex].bringToFront();
      }
      const group = L.featureGroup(state.lRouteLines);
      state.lMap.fitBounds(group.getBounds(), { padding: [30, 30] });
    }

    renderRouteCards();
  }

  // Hàm tổng quát tính toán lộ trình
  async function buildRoute(from, isReroute = false) {
    if (state.mapEngine === 'google' && state.gDirectionsService) {
      return buildRouteGoogle(from, isReroute);
    } else {
      return buildRouteOsm(from, isReroute);
    }
  }

  return {
    buildRoute,
    selectRoute,
    clearAltRoutes,
    renderRouteCards
  };
})();
