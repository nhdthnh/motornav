/**
 * MotoNav - Main Application Controller
 * Khởi tạo ứng dụng và gắn kết các sự kiện người dùng.
 *
 * Các xử lý quan trọng khi iPhone tắt/mở màn hình:
 *  - visibilitychange / pageshow: kết nối lại BLE ngay, khôi phục GPS, gửi lại
 *    lộ trình + chỉ dẫn xuống OLED, bật lại keep-alive audio + wake lock.
 *  - scheduleAutoResume: nếu iOS/Bluefy đã kill trang, khi mở lại app tự phục
 *    hồi phiên dẫn đường đang dở (dest đã lưu trong localStorage).
 */
window.MotoNav = window.MotoNav || {};

document.addEventListener('DOMContentLoaded', () => {
  const { $, lockScreen } = MotoNav.utils;
  const state = MotoNav.state;

  // 1. Kết nối BLE
  $('btnConn').onclick = () => {
    if (MotoNav.background && typeof MotoNav.background.start === 'function') {
      MotoNav.background.start();
    }
    if (state.device && state.device.gatt && state.device.gatt.connected) {
      MotoNav.ble.disconnect();
    } else if (state.device) {
      // Đã từng chọn thiết bị trong phiên này -> thử kết nối lại ngay trong cử chỉ bấm nút
      MotoNav.ble.reconnectNow(true);
      MotoNav.utils.setMsg('Đang thử kết nối lại màn hình BW16…');
    } else {
      MotoNav.ble.doConnectBle(false);
    }
  };

  $('btnConnAll').onclick = () => {
    if (MotoNav.background && typeof MotoNav.background.start === 'function') {
      MotoNav.background.start();
    }
    MotoNav.ble.doConnectBle(true);
  };

  // Nút gửi lại lộ trình offline xuống BW16 (dùng khi OLED bị lệch/hết dữ liệu)
  const btnResync = $('btnResync');
  if (btnResync) {
    btnResync.onclick = () => MotoNav.navigation.resyncToDevice();
  }

  // 2. Cấu hình Google Maps API Key
  $('btnToggleKey').onclick = () => {
    const box = $('keyBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') {
      $('keyInput').value = MotoNav.map.getStoredKey();
    }
  };

  $('btnSaveKey').onclick = () => {
    const key = $('keyInput').value.trim();
    if (!key) {
      alert('Vui lòng nhập Google Maps API Key hợp lệ');
      return;
    }
    MotoNav.map.saveKey(key);
  };

  $('btnClearKey').onclick = () => {
    MotoNav.map.clearKey();
  };

  // 3. Tìm kiếm địa điểm
  $('btnSearch').onclick = () => {
    MotoNav.search.performSearch();
  };

  $('q').addEventListener('input', e => {
    MotoNav.search.onInput(e.target.value.trim());
  });

  $('q').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      MotoNav.search.performSearch();
    }
  });

  // 4. Bắt đầu / Dừng dẫn đường
  $('btnStart').onclick = () => {
    if (MotoNav.background && typeof MotoNav.background.start === 'function') {
      MotoNav.background.start();
    }
    lockScreen();
    MotoNav.navigation.startNavigation();
  };

  $('btnStop').onclick = () => {
    MotoNav.navigation.stopNavigation();
  };

  // 5. Định vị vị trí hiện tại
  $('btnLocate').onclick = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(p => {
        state.lastPos = [p.coords.longitude, p.coords.latitude];
        MotoNav.map.panTo(state.lastPos);
        MotoNav.utils.setMsg('Đã định vị vị trí GPS hiện tại');
      }, e => MotoNav.navigation.onGpsError(e), { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    }
  };

  // 6. Thử nghiệm gửi tín hiệu lên màn hình OLED BW16
  document.querySelectorAll('button[data-t]').forEach(b => {
    b.onclick = () => MotoNav.ble.send(b.dataset.t + '\n', true);
  });

  // 7. Khi màn hình/tab hoạt động trở lại (mở khoá iPhone, quay lại Bluefy…)
  let lastVisibleAt = 0;
  function onAppVisible() {
    const now = Date.now();
    if (now - lastVisibleAt < 600) return; // tránh chạy trùng lặp do nhiều event
    lastVisibleAt = now;
    console.log('[MotoNav] Màn hình/tab hoạt động trở lại');

    if (MotoNav.background) {
      if (typeof MotoNav.background.kick === 'function') MotoNav.background.kick();
      else if (typeof MotoNav.background.start === 'function') MotoNav.background.start();
    }

    // Thử kết nối lại BLE ngay (kể cả khi iOS đã ngắt kết nối lúc khoá máy)
    if (state.device) MotoNav.ble.reconnectNow(true);

    // Khôi phục GPS + gửi lại chỉ dẫn/lộ trình xuống OLED
    if (state.navigating) MotoNav.navigation.resumeAfterBackground();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onAppVisible();
    else MotoNav.navigation.prepareForBackground();
  });
  window.addEventListener('pageshow', onAppVisible);
  window.addEventListener('pagehide', () => MotoNav.navigation.prepareForBackground());
  document.addEventListener('resume', onAppVisible); // WKWebView/Bluefy (nếu có hỗ trợ)

  // 8. Lấy toạ độ GPS ban đầu để sẵn sàng tìm đường ngay khi gõ điểm đến
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => {
      state.lastPos = [p.coords.longitude, p.coords.latitude];
    }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }

  // 9. Khởi động Bản đồ, sau khi xong thì thử khôi phục phiên dẫn đường đang dở
  MotoNav.map.initEngine().then(() => {
    MotoNav.navigation.scheduleAutoResume();
  });

  // 10. Chế độ Bỏ Túi (Màn hình đen OLED tiết kiệm pin khi đút túi quần)
  const btnPocket = $('btnPocketMode');
  const pocketOverlay = $('pocketOverlay');
  if (btnPocket && pocketOverlay) {
    btnPocket.onclick = () => {
      pocketOverlay.style.display = 'flex';
      lockScreen();
      if (MotoNav.background && typeof MotoNav.background.start === 'function') {
        MotoNav.background.start();
      }
    };

    let lastTap = 0;
    const handleExitPocket = (e) => {
      const now = Date.now();
      if (now - lastTap < 450) {
        // Double-tap thành công: thoát màn hình đen
        pocketOverlay.style.display = 'none';
        if (e && e.preventDefault) e.preventDefault();
      }
      lastTap = now;
    };

    pocketOverlay.addEventListener('click', handleExitPocket);
    pocketOverlay.addEventListener('touchend', handleExitPocket);
  }
});
