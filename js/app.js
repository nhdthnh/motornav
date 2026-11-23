/**
 * MotoNav - Main Application Controller
 * Khởi tạo ứng dụng và gắn kết các sự kiện người dùng
 */
window.MotoNav = window.MotoNav || {};

document.addEventListener('DOMContentLoaded', () => {
  const { $ } = MotoNav.utils;
  const state = MotoNav.state;

  // 1. Kết nối BLE
  $('btnConn').onclick = () => {
    if (state.device && state.device.gatt && state.device.gatt.connected) {
      MotoNav.ble.disconnect();
    } else {
      MotoNav.ble.doConnectBle(false);
    }
  };

  $('btnConnAll').onclick = () => {
    MotoNav.ble.doConnectBle(true);
  };

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

  // 7. Giữ màn hình sáng khi quay lại tab trình duyệt
  document.addEventListener('visibilitychange', () => {
    if (state.navigating && document.visibilityState === 'visible') {
      MotoNav.utils.lockScreen();
    }
  });

  // 8. Lấy toạ độ GPS ban đầu để sẵn sàng tìm đường ngay khi gõ điểm đến
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => {
      state.lastPos = [p.coords.longitude, p.coords.latitude];
    }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }

  // 9. Khởi động Bản đồ
  MotoNav.map.initEngine();
});
