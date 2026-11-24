/**
 * MotoNav - Navigation & Auto-Reroute Engine
 * Xử lý định vị GPS thời gian thực, tính lại đường khi lệch và gửi lệnh BLE
 * xuống BW16.
 *
 * ĐIỂM MỚI QUAN TRỌNG: "Lộ trình nạp trước" (offline plan)
 *  - Khi bắt đầu dẫn đường, app gửi toàn bộ các chặng sắp tới xuống BW16.
 *  - Nếu iPhone tắt màn hình khiến BLE rớt, BW16 tự chạy tiếp lộ trình đã nạp
 *    (tự đếm lùi khoảng cách + chuyển chặng) và hiển thị nhãn "OFF".
 *  - Khi màn hình mở lại và BLE kết nối lại, app gửi lại lộ trình + đồng bộ
 *    bước hiện tại nên OLED trở về đúng vị trí thực tế ngay lập tức.
 */
window.MotoNav = window.MotoNav || {};

MotoNav.navigation = (() => {
  const { $, fmt, hav, alongLine, ascii, renderHUD, setMsg, lockScreen, releaseScreen } = MotoNav.utils;
  const state = MotoNav.state;

  const MAX_PLAN_ENTRIES = 32;              // số chặng gửi trước xuống BW16
  const SESSION_KEY = 'motonav_session_v1'; // lưu phiên để khôi phục khi iOS kill trang
  const SESSION_MAX_AGE = 12 * 3600 * 1000; // 12 giờ

  // Giải mã hướng rẽ từ bước của Google Maps
  function dirFromGoogleStep(step) {
    if (!step) return 'S';
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
    return ascii(st).replace(/[\r\n|]/g, ' ').slice(0, 45);
  }

  // Giải mã hướng rẽ từ OpenStreetMap OSRM
  function dirFromOsrm(m) {
    m = m || {};
    if (m.type === 'arrive') return 'A';
    const mod = m.modifier || '';
    if (mod === 'uturn') return 'U';
    if (mod.includes('left')) return 'L';
    if (mod.includes('right')) return 'R';
    return 'S';
  }

  // ------------------------------------------------------------------
  //  Lộ trình nạp trước (offline plan)
  // ------------------------------------------------------------------
  // Tạo danh sách chặng từ bước hiện tại: mỗi chặng = 1 lần rẽ sắp tới
  // { dir, distM, durS, street } - khớp với cấu trúc PlanStep trong firmware.
  function buildPlan(startK, maxEntries) {
    const steps = state.steps || [];
    const len = steps.length;
    const google = state.mapEngine === 'google';
    const out = [];

    for (let j = 0; j < maxEntries; j++) {
      const segIdx = startK + j;
      const instIdx = segIdx + 1;
      if (instIdx >= len) break;
      const seg = steps[segIdx];
      const inst = steps[instIdx];
      if (!seg || !inst) break;

      let dir = 'S', distM = 0, durS = 0, street = '';

      if (google) {
        distM = (seg.distance && seg.distance.value) || 0;
        durS = (seg.duration && seg.duration.value) || 0;
        dir = dirFromGoogleStep(inst);
        street = streetFromGoogleStep(inst);
        const txt = ((inst.instructions || '') + ' ' + (inst.maneuver || '')).toLowerCase();
        if (instIdx === len - 1 && (txt.includes('arrive') || txt.includes('đến') || txt.includes('den noi'))) {
          dir = 'A';
          street = street || 'Diem den';
        }
      } else {
        distM = seg.distance || 0;
        durS = seg.duration || 0;
        dir = dirFromOsrm(inst.maneuver);
        street = ascii(inst.name || inst.ref || '');
        if (dir === 'A') street = street || 'Diem den';
      }

      street = ascii(street).replace(/[\r\n|]/g, ' ').slice(0, 45);
      out.push({
        dir,
        distM: Math.max(0, Math.round(distM)),
        durS: Math.max(0, Math.round(durS)),
        street
      });
    }
    return out;
  }

  // Gửi lộ trình đã nạp xuống BW16 (bắt đầu lại từ bước hiện tại)
  function sendPlanToDevice() {
    if (!state.navigating) return false;
    const plan = buildPlan(state.k, MAX_PLAN_ENTRIES);
    state.plan = plan;
    state.planBaseK = state.k;
    state.planSeqSent = 0;
    if (!plan.length) return false;
    return MotoNav.ble.sendPlan(plan);
  }

  function sendPlanAndSync() {
    if (!sendPlanToDevice()) return false;
    MotoNav.ble.sendPS(0);
    return true;
  }

  // Đồng bộ bước hiện tại xuống BW16 mỗi khi vượt qua một chặng
  function syncPlanSequence() {
    if (!state.navigating) return;
    if (!state.plan || !state.plan.length) return;
    const seq = state.k - state.planBaseK;
    if (seq < 0 || seq >= state.plan.length) {
      // Đã đi hết số chặng đã nạp -> nạp tiếp từ vị trí hiện tại
      sendPlanAndSync();
      return;
    }
    if (seq !== state.planSeqSent) {
      state.planSeqSent = seq;
      MotoNav.ble.sendPS(seq);
    }
  }

  // Được BLE module gọi ngay sau khi kết nối/kết nối lại: đồng bộ toàn bộ trạng thái
  function onBleReady() {
    if (!state.navigating) return;
    sendPlanAndSync();
    if (state.curMsg) MotoNav.ble.send(state.curMsg, true);
    if (state.lastPos) updateNavGuidance(state.lastPos);
  }

  // Nút "Gửi lại lộ trình" trên giao diện
  function resyncToDevice() {
    if (!state.navigating) {
      MotoNav.ble.sendRaw('K||\n');
      setMsg('Chưa dẫn đường nên không có lộ trình để gửi.');
      return;
    }
    const sent = sendPlanAndSync();
    if (state.curMsg) MotoNav.ble.send(state.curMsg, true);
    setMsg(sent
      ? 'Đã gửi lại lộ trình + chỉ dẫn hiện tại xuống màn hình OLED.'
      : 'Không gửi được: chưa kết nối màn hình BW16.');
  }

  // ------------------------------------------------------------------
  //  Chỉ dẫn & tự động reroute
  // ------------------------------------------------------------------
  function arriveMessage() {
    return 'A|0m|' + ascii((state.dest && state.dest.name) || 'Diem den').replace(/[\r\n|]/g, ' ').slice(0, 45) + '\n';
  }

  function handleArrival() {
    if (!state.arrived) {
      const m = arriveMessage();
      state.curMsg = m;
      renderHUD('A', '0m', 'Da den noi');
      MotoNav.ble.send(m, true);
      // Xoá lộ trình offline để lần mất kết nối sau không đếm lùi sai
      MotoNav.ble.sendRaw('PC|\n');
      state.plan = null;
      state.planSeqSent = 0;
      state.arrived = true;
      clearSession();
      setMsg('Đã đến nơi!');
    }
  }

  // Cập nhật hướng dẫn dẫn đường và truyền qua BLE
  function updateNavGuidance(p) {
    if (!state.navigating || !state.steps || !state.steps.length) return;

    if (state.mapEngine === 'google') {
      const len = state.steps.length;

      // Bỏ qua các bước đã đi qua (tới sát điểm cuối của bước hiện tại)
      while (state.k < len - 1) {
        const cur = state.steps[state.k];
        if (!cur || !cur.end_location) break;
        const endPt = [cur.end_location.lng(), cur.end_location.lat()];
        if (hav(p, endPt) < 25) state.k++;
        else break;
      }

      // Bước cuối cùng = đã tới đích
      if (state.k >= len - 1) {
        handleArrival();
        return;
      }

      const curStep = state.steps[state.k];
      if (!curStep || !curStep.end_location) return;
      const nextStep = state.steps[state.k + 1];
      const endPt = [curStep.end_location.lng(), curStep.end_location.lat()];
      const d = hav(p, endPt);
      // Hướng rẽ của BƯỚC KẾ TIẾP (maneuver nằm ở đầu bước kế tiếp)
      const dir = dirFromGoogleStep(nextStep);
      const st = streetFromGoogleStep(nextStep) || 'Diem den';
      const m = `${dir}|${fmt(d)}|${st}\n`;
      state.curMsg = m;
      renderHUD(dir, fmt(d), st);
      syncPlanSequence();
      MotoNav.ble.send(m);
    } else {
      const len = state.steps.length;

      while (state.k < len - 1 && state.steps[state.k + 1].maneuver &&
             hav(p, state.steps[state.k + 1].maneuver.location) < 25) {
        state.k++;
      }

      if (state.k >= len - 1) {
        handleArrival();
        return;
      }

      const stepLine = state.steps[state.k].geometry.coordinates;
      const al = alongLine(p, stepLine);
      const up = state.steps[state.k + 1];
      const d = al.off < 100 ? al.rem : hav(p, up.maneuver.location);
      const dir = dirFromOsrm(up.maneuver);
      const st = ascii(up.name || up.ref || '').replace(/[\r\n|]/g, ' ').slice(0, 45);
      const m = `${dir}|${fmt(d)}|${st}\n`;
      state.curMsg = m;
      renderHUD(dir, fmt(d), st);
      syncPlanSequence();
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
      if (state.navigating) sendPlanAndSync();
      updateNavGuidance(p);
    } catch (e) {
      console.warn('Lỗi reroute:', e);
      setMsg('Lỗi tự động tính lại đường: ' + e.message);
    } finally {
      state.rerouting = false;
      state.offCount = 0;
      state.rerouteGraceUntil = Date.now() + 6000;
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

    // Lưu phiên định kỳ để iOS/Bluefy kill trang vẫn khôi phục được
    if (Date.now() - state.lastSessionSave > 30000) saveSession();

    // Cập nhật bước hướng dẫn rẽ hiện tại
    updateNavGuidance(p);

    // TỰ ĐỘNG ĐIỀU CHỈNH HƯỚNG ĐI KHI LỆCH TUYẾN ĐƯỜNG:
    // Nếu xe cách xa tuyến đường > 45m (thích ứng độ chính xác GPS) trong 4 nhịp GPS liên tiếp -> Reroute
    if (state.routeLine && state.routeLine.length >= 2) {
      if (Date.now() < (state.rerouteGraceUntil || 0)) {
        state.offCount = 0;
        return;
      }
      const offTrack = alongLine(p, state.routeLine).off;
      const offThreshold = Math.max(45, (pos.coords.accuracy || 20) * 0.9);
      if (offTrack > offThreshold) {
        state.offCount++;
      } else {
        state.offCount = 0;
      }

      if (state.offCount >= 4 && !state.rerouting) {
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
      maximumAge: 2000,
      timeout: 15000
    });
  }

  function stopGpsWatch() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    clearInterval(state.gpsWatchdogTimer);
  }

  // ------------------------------------------------------------------
  //  Lưu / khôi phục phiên
  // ------------------------------------------------------------------
  function saveSession() {
    try {
      if (!state.navigating || !state.dest) return;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        dest: {
          name: state.dest.name || '',
          lat: state.dest.lat,
          lon: state.dest.lon
        },
        savedAt: Date.now()
      }));
      state.lastSessionSave = Date.now();
    } catch (e) {}
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    state.lastSessionSave = 0;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.dest || typeof s.dest.lat !== 'number' || typeof s.dest.lon !== 'number') return null;
      if (!s.savedAt || Date.now() - s.savedAt > SESSION_MAX_AGE) {
        clearSession();
        return null;
      }
      return s;
    } catch (e) {
      return null;
    }
  }

  // Gọi sau khi bản đồ khởi tạo xong: nếu có phiên dở dang thì tự khôi phục
  function scheduleAutoResume() {
    if (state.navigating) return false;
    const s = loadSession();
    if (!s) return false;

    state.dest = {
      name: s.dest.name,
      lat: s.dest.lat,
      lon: s.dest.lon,
      gLocation: (window.google && window.google.maps && google.maps.LatLng)
        ? new google.maps.LatLng(s.dest.lat, s.dest.lon) : null
    };
    state.pendingResume = true;
    setMsg('Có phiên dẫn đường trước đó, đang khôi phục…');

    setTimeout(() => {
      if (!state.pendingResume || state.navigating) return;
      state.pendingResume = false;
      startNavigation().then(() => {
        setMsg('Đã khôi phục phiên dẫn đường. Nếu OLED chưa kết nối, bấm "Kết nối MotoNav".');
      }).catch(e => {
        setMsg('Không khôi phục được phiên dẫn đường: ' + e.message);
      });
    }, 1200);

    return true;
  }

  // Được gọi khi tab/màn hình hoạt động trở lại sau khi bị iOS treo
  function resumeAfterBackground() {
    if (!state.navigating) return;

    const stale = !state.lastGpsFix || (Date.now() - state.lastGpsFix > 8000);
    if (stale) {
      console.log('[MotoNav] GPS có thể đã bị treo khi tắt màn hình -> khởi động lại watchPosition');
      startGpsWatch();
    }

    if (state.lastPos) updateNavGuidance(state.lastPos);
    if (state.curMsg) MotoNav.ble.send(state.curMsg, true);
    if (state.plan && state.plan.length) MotoNav.ble.sendPS(state.planSeqSent);

    lockScreen();
    setMsg('Đã mở lại màn hình: dẫn đường tiếp tục.');
  }

  // Được gọi khi màn hình/tab sắp bị iOS tạm dừng:
  //  - lưu phiên để khôi phục nếu Bluefy bị kill
  //  - báo BW16 chuyển ngay sang chế độ offline (không phải chờ timeout 12s)
  function prepareForBackground() {
    if (!state.navigating) return;
    saveSession();
    MotoNav.ble.sendRaw('GO|\n');
  }

  // ------------------------------------------------------------------
  //  Bắt đầu / dừng dẫn đường
  // ------------------------------------------------------------------
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
      state.arrived = false;
      state.lastGpsFix = Date.now();
      state.offCount = 0;
      state.rerouteGraceUntil = Date.now() + 10000;
      startGpsWatch();

      // GPS Watchdog: Tự phục hồi bộ thu GPS nếu quá 15s không nhận được tín hiệu.
      // Đồng thời, nếu page còn sống trong nền (nhờ audio keep-alive) mà GPS đã chết
      // thì báo firmware chuyển sang chế độ offline.
      clearInterval(state.gpsWatchdogTimer);
      state.gpsWatchdogTimer = setInterval(() => {
        if (!state.navigating) return;
        const gpsAge = Date.now() - state.lastGpsFix;
        if (gpsAge > 15000) {
          console.warn('GPS Watchdog: Tự động khởi động lại bộ thu GPS…');
          startGpsWatch();
        }
        if (document.visibilityState === 'hidden' && gpsAge > 6000) {
          MotoNav.ble.sendRaw('GO|\n');
        }
      }, 5000);

      lockScreen();
      if (MotoNav.background && typeof MotoNav.background.start === 'function') {
        MotoNav.background.start();
      }

      setMsg('Đang dẫn đường');
      updateNavGuidance(p);
      // Nạp lộ trình offline xuống BW16 (sau khi đã có bước hiện tại chuẩn)
      sendPlanAndSync();
      saveSession();
    } catch (e) {
      setMsg('Lỗi: ' + e.message);
    }
  }

  // Dừng dẫn đường
  function stopNavigation() {
    state.navigating = false;
    state.arrived = false;
    state.pendingResume = false;
    state.plan = null;
    state.planSeqSent = 0;
    state.planBaseK = 0;
    stopGpsWatch();
    releaseScreen();
    MotoNav.ble.send('X||\n', true);
    MotoNav.ble.sendRaw('PC|\n');
    clearSession();
    renderHUD('X', '--', 'Đã dừng');
    setMsg('Đã dừng dẫn đường');
  }

  return {
    dirFromGoogleStep,
    streetFromGoogleStep,
    dirFromOsrm,
    buildPlan,
    sendPlanToDevice,
    sendPlanAndSync,
    syncPlanSequence,
    onBleReady,
    resyncToDevice,
    updateNavGuidance,
    reroute,
    onPos,
    onGpsError,
    startNavigation,
    stopNavigation,
    scheduleAutoResume,
    resumeAfterBackground,
    prepareForBackground,
    saveSession,
    clearSession,
    loadSession
  };
})();
