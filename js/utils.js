/**
 * MotoNav - Utility & Geometry Functions
 */
window.MotoNav = window.MotoNav || {};

MotoNav.utils = (() => {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const enc = new TextEncoder();

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Loại bỏ dấu tiếng Việt để hiển thị tốt trên màn hình OLED SSD1306
  const ascii = s => (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

  // Định dạng khoảng cách hiển thị trực quan (mét hoặc kilômét)
  const fmt = d => d >= 1000 ? (d / 1000).toFixed(1) + 'km' : (Math.round(d / 10) * 10) + 'm';

  // Tính khoảng cách Haversine giữa 2 toạ độ [lon, lat] theo mét
  function hav(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Đo khoảng cách lệch (off-track) và quãng đường còn lại dọc theo polyline
  function alongLine(p, coords) {
    if (!coords || coords.length < 2) return { off: 0, rem: 0 };
    const kx = Math.cos(rad(p[1])) * rad(1) * R, ky = rad(1) * R;
    const X = c => [(c[0] - p[0]) * kx, (c[1] - p[1]) * ky];
    let best = Infinity, bi = 0, bt = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = X(coords[i]), b = X(coords[i + 1]);
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 ? (-a[0] * dx - a[1] * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    let rem = 0;
    const a = X(coords[bi]), b = X(coords[bi + 1]);
    rem += (1 - bt) * Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let i = bi + 1; i < coords.length - 1; i++) rem += hav(coords[i], coords[i + 1]);
    return { off: best, rem, bi };
  }

  // Cập nhật dòng trạng thái thông báo
  function setMsg(t) {
    const el = $('msg');
    if (el) el.textContent = t;
  }

  // Hiển thị chỉ dẫn HUD lớn trên màn hình điện thoại
  function renderHUD(dir, dist, street) {
    const g = { L: '⬅', R: '➡', S: '⬆', U: '↩', A: '⚑', X: '–' };
    const arrowEl = $('arrow'), distEl = $('dist'), streetEl = $('street');
    if (arrowEl) arrowEl.textContent = g[dir] || '–';
    if (distEl) distEl.textContent = dist || '--';
    if (streetEl) streetEl.textContent = street || '';
  }

  // Giữ màn hình điện thoại luôn sáng khi đang dẫn đường (Screen WakeLock)
  async function lockScreen() {
    try {
      if ('wakeLock' in navigator && !MotoNav.state.wake) {
        MotoNav.state.wake = await navigator.wakeLock.request('screen');
      }
    } catch (e) {
      console.warn('WakeLock not supported or permitted:', e);
    }
  }

  return {
    $,
    sleep,
    enc,
    ascii,
    fmt,
    hav,
    alongLine,
    setMsg,
    renderHUD,
    lockScreen
  };
})();
