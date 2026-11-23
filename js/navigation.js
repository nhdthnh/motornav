/**
 * MotoNav - Navigation & Auto-Reroute Engine
 * Xử lý định vị GPS thời gian thực, thuật toán tự động tính lại đường và gửi lệnh BLE xuống BW16
 */
window.MotoNav = window.MotoNav || {};

MotoNav.navigation = (() => {
  const { $, fmt, hav, alongLine, ascii, renderHUD, setMsg, lockScreen } = MotoNav.utils;
  const state = MotoNav.state;

  // Giải mã hướng rẽ từ bước của Google Maps
  function dirFromGoogleStep(step) {
    const m = (step.maneuver || '').toLowerCase();
    if (m.includes('uturn')) return 'U';
    if (m.includes('left')) return 'L';
    if (m.includes('right')) return 'R';
    if (m.includes('straight')) return 'S';

    const text = (step.instructions || '').toLowerCase();
    if (text.includes('quay đầu') || text.includes('u-turn')) return 'U';
    if (text.includes('trái') || text.includes('left')) return 'L';
    if (text.includes('phải') || text.includes('right')) return 'R';
    return 'S';
  }

  // Tách tên đường gọn gàng từ chỉ dẫn của Google Maps
  function streetFromGoogleStep(step) {
    if (!step || !step.instructions) return '';
    const bolds = [...step.instructions.matchAll(/<b>(.*?)<\/b>/g)].map(x => x[1]);
    let st = '';
    if (bolds.length >= 2) st = bolds[bolds.length - 1];
    else if (bolds.length === 1) st = bolds[0];
    else st = step.instructions.replace(/<[^>]*>/g, '').trim();
    return ascii(st).slice(0, 15);
  }

  // Giải mã hướng rẽ từ OpenStreetMap OSRM
  function dirFromOsrm(m) {
    if (m.type === 'arrive') return 'A';
    const mod = m.modifier || '';
    if (mod === 'uturn') return 'U';
    if (mod.includes('left')) return 'L';
    if (mod.includes('right')) return 'R';
    return 'S';
  }

  // Cập nhật hướng dẫn dẫn đường và truyền qua BLE
  function updateNavGuidance(p) {
    if (!state.navigating || !state.steps || !state.steps.length) return;

    if (state.mapEngine === 'google') {
      while (state.k < state.steps.length - 1) {
        const endPt = [state.steps[state.k].end_location.lng(), state.steps[state.k].end_location.lat()];
        if (hav(p, endPt) < 25) state.k++;
        else break;
      }

      if (state.k >= state.steps.length) {
        const m = 'A|0m|' + ascii(state.dest.name).slice(0, 15) + '\n';
        state.curMsg = m;
        renderHUD('A', '0m', 'Da den noi');
        MotoNav.ble.send(m);
        setMsg('Đã đến nơi!');
        return;
      }

      const curStep = state.steps[state.k];
      const endPt = [curStep.end_location.lng(), curStep.end_location.lat()];
      const d = hav(p, endPt);
      const dir = dirFromGoogleStep(curStep);
      const st = streetFromGoogleStep(curStep) || 'Diem den';
      const m = `${dir}|${fmt(d)}|${st}\n`;
      state.curMsg = m;
      renderHUD(dir, fmt(d), st);
      MotoNav.ble.send(m);
    } else {
      while (state.k < state.steps.length - 1 && hav(p, state.steps[state.k + 1].maneuver.location) < 25) {
        state.k++;
      }

      if (state.k >= state.steps.length - 1) {
        const m = 'A|0m|' + ascii(state.dest.name).slice(0, 15) + '\n';
        state.curMsg = m;
        renderHUD('A', '0m', 'Da den noi');
        MotoNav.ble.send(m);
        setMsg('Đã đến nơi!');
        return;
      }

      const stepLine = state.steps[state.k].geometry.coordinates;
      const al = alongLine(p, stepLine);
      const up = state.steps[state.k + 1];
      const d = al.off < 100 ? al.rem : hav(p, up.maneuver.location);
      const dir = dirFromOsrm(up.maneuver);
      const st = ascii(up.name || up.ref || '').slice(0, 15);
      const m = `${dir}|${fmt(d)}|${st}\n`;
      state.curMsg = m;
      renderHUD(dir, fmt(d), st);
      MotoNav.ble.send(m);
    }
  }

  // Tự động tính lại tuyến đường khi xe đi lệch lộ trình (Reroute)
  async function reroute(p) {
    state.rerouting = true;
    setMsg('⚠️ Lệch lộ trình: Đang tự động tìm tuyến đường mới…');
    try {
      await MotoNav.routing.buildRoute(p, true);
      setMsg('🔄 Đã tự động cập nhật lộ trình mới!');
      updateNavGuidance(p);
    } catch (e) {
      console.warn('Lỗi reroute:', e);
      setMsg('Lỗi tự động tính lại đường: ' + e.message);
    } finally {
      state.rerouting = false;
    }
  }

  // Xử lý toạ độ GPS nhận được
  function onPos(pos) {
    state.lastGpsFix = Date.now();
    if (state.navigating) setMsg('Đang dẫn đường');
    if (pos.coords.accuracy > 80) return; // Bỏ qua toạ độ quá nhiễu

    const p = [pos.coords.longitude, pos.coords.latitude];
    state.lastPos = p;

    // Cập nhật vị trí lên Google Map hoặc Leaflet
    if (state.mapEngine === 'google' && state.gMap && state.gUserMarker) {
      const latLng = new google.maps.LatLng(p[1], p[0]);
      state.gUserMarker.setPosition(latLng);
      if (pos.coords.heading !== null && !isNaN(pos.coords.heading)) {
        state.gUserMarker.setIcon({
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 6,
          fillColor: '#0284c7',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          rotation: pos.coords.heading
        });
      }
      if (state.navigating) state.gMap.panTo(latLng);
    } else if (state.lMap && state.lUserMarker) {
      state.lUserMarker.setLatLng([p[1], p[0]]);
      if (state.navigating) state.lMap.panTo([p[1], p[0]]);
    }

    if (!state.navigating || !state.steps || !state.steps.length) return;

    // Cập nhật bước hướng dẫn rẽ hiện tại
    updateNavGuidance(p);

    // TỰ ĐỘNG ĐIỀU CHỈNH HƯỚNG ĐI KHI LỆCH TUYẾN ĐƯỜNG:
    // Nếu xe cách xa tuyến đường > 35m trong 2 nhịp GPS liên tiếp -> Reroute ngay lập tức
    if (state.routeLine && state.routeLine.length >= 2) {
      const offTrack = alongLine(p, state.routeLine).off;
      if (offTrack > 35) state.offCount++;
      else state.offCount = 0;

      if (state.offCount >= 2 && !state.rerouting) {
        reroute(p);
      }
    }
  }

  function onGpsError(e) {
    console.warn('GPS Error:', e.code, e.message);
    if (e.code === 3) {
      setMsg('Đang tìm vệ tinh GPS… (Nếu ở trong nhà hãy ra gần cửa sổ hoặc ra ngoài trời)');
    } else if (e.code === 1) {
      setMsg('GPS bị chặn: Vui lòng cho phép quyền Vị trí trong Cài đặt trình duyệt/điện thoại.');
    } else {
      setMsg('Tín hiệu GPS yếu: ' + e.message);
    }
  }

  function startGpsWatch() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = navigator.geolocation.watchPosition(onPos, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 10000
    });
  }

  function stopGpsWatch() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    clearInterval(state.gpsWatchdogTimer);
  }

  // Bắt đầu dẫn đường
  async function startNavigation() {
    if (!state.dest) {
      setMsg('Hãy tìm và chọn điểm đến trước');
      return;
    }
    try {
      let p = state.lastPos;
      if (!p) {
        setMsg('Đang lấy toạ độ GPS…');
        const pos = await new Promise((ok, err) =>
          navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }));
        p = [pos.coords.longitude, pos.coords.latitude];
        state.lastPos = p;
      }

      // Nếu chưa có lộ trình thì tính lộ trình
      if (!state.routeLine || !state.routeLine.length) {
        setMsg('Đang tính lộ trình…');
        await MotoNav.routing.buildRoute(p);
      }

      state.navigating = true;
      state.lastGpsFix = Date.now();
      startGpsWatch();

      // GPS Watchdog: Tự phục hồi bộ thu GPS nếu quá 15s không nhận được tín hiệu
      clearInterval(state.gpsWatchdogTimer);
      state.gpsWatchdogTimer = setInterval(() => {
        if (state.navigating && Date.now() - state.lastGpsFix > 15000) {
          console.warn('GPS Watchdog: Tự động khởi động lại bộ thu GPS…');
          startGpsWatch();
        }
      }, 5000);

      lockScreen();
      setMsg('Đang dẫn đường');
      updateNavGuidance(p);
    } catch (e) {
      setMsg('Lỗi: ' + e.message);
    }
  }

  // Dừng dẫn đường
  function stopNavigation() {
    state.navigating = false;
    stopGpsWatch();
    if (state.wake) {
      state.wake.release().catch(() => {});
      state.wake = null;
    }
    MotoNav.ble.send('X||\n', true);
    renderHUD('X', '--', 'Đã dừng');
    setMsg('Đã dừng dẫn đường');
  }

  return {
    dirFromGoogleStep,
    streetFromGoogleStep,
    dirFromOsrm,
    updateNavGuidance,
    reroute,
    onPos,
    onGpsError,
    startNavigation,
    stopNavigation
  };
})();
