/**
 * MotoNav - Bluetooth Low Energy (BLE) Module
 * Giao tiếp với mạch BW16 (RTL8720DN) qua chuẩn Nordic UART Service
 */
window.MotoNav = window.MotoNav || {};

MotoNav.ble = (() => {
  const { $, sleep, enc, lockScreen } = MotoNav.utils;
  const state = MotoNav.state;

  const SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const RXU = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
  let lastFullSendTime = 0;

  // Cập nhật trạng thái kết nối lên UI
  function setBleStatus(text, ok) {
    const bleState = $('bleState'), bleMsg = $('bleMsg'), btnConn = $('btnConn'), btnConnAll = $('btnConnAll');
    if (bleState) {
      bleState.textContent = ok ? '🟢 ĐÃ KẾT NỐI' : 'Chưa kết nối màn hình';
      bleState.className = 'pill ' + (ok ? 'ok' : 'warn');
    }
    if (bleMsg) bleMsg.textContent = text;
    if (btnConn) {
      if (ok) {
        btnConn.textContent = '✅ Đã kết nối MotoNav (Bấm để ngắt)';
        btnConn.style.background = 'var(--ok)';
        btnConn.style.color = '#ffffff';
        if (btnConnAll) btnConnAll.style.display = 'none';
      } else {
        btnConn.textContent = 'Kết nối MotoNav';
        btnConn.style.background = 'var(--acc)';
        btnConn.style.color = '#ffffff';
        if (btnConnAll) btnConnAll.style.display = 'block';
      }
    }
  }

  // Heartbeat định kỳ gửi xuống BW16 (được gọi bởi Web Worker ngầm hoặc setInterval)
  function onHeartbeatTick() {
    if (!state.rxChar) return;
    const now = Date.now();
    if (state.navigating && state.curMsg) {
      // Nếu đã hơn 5s chưa gửi gói tin điều hướng (ví dụ đang dừng đèn đỏ hoặc chạy thẳng),
      // gửi lại curMsg với force=true để OLED luôn hiển thị đúng và không bao giờ bị timeout
      if (now - lastFullSendTime > 5000) {
        send(state.curMsg, true);
      } else {
        sendRaw('K||\n');
      }
    } else {
      sendRaw('K||\n');
    }
  }

  // Kết nối tới GATT Server và lấy đặc tính RX
  async function openGatt() {
    const server = await state.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    state.rxChar = await svc.getCharacteristic(RXU);
    state.lastMsg = '';
    lastFullSendTime = Date.now();
    setBleStatus('Đã kết nối thành công với ' + (state.device.name || 'MotoNav'), true);

    // Kích hoạt chế độ chạy ngầm (Silent Audio + Web Worker)
    if (MotoNav.background && typeof MotoNav.background.start === 'function') {
      MotoNav.background.start();
    }

    // Gửi xác nhận kết nối lên OLED ngay lập tức: C|OK|Da ket noi
    send('C|OK|Da ket noi\n', true);

    // Duy trì nhịp tim BLE (Heartbeat) dự phòng mỗi 2.5s
    clearInterval(state.blePingTimer);
    state.blePingTimer = setInterval(onHeartbeatTick, 2500);

    // Kích hoạt giữ màn hình sáng
    lockScreen();
  }

  // Xử lý khi mất kết nối BLE và tự động kết nối lại
  function onDisconnected() {
    state.rxChar = null;
    state.busy = false;
    state.queued = null;
    clearInterval(state.blePingTimer);
    setBleStatus('Mất kết nối BLE, đang tự kết nối lại…', false);
    const retry = async () => {
      if (state.rxChar || !state.device) return;
      try {
        await openGatt();
      } catch (e) {
        setTimeout(retry, 2500);
      }
    };
    setTimeout(retry, 1000);
  }

  // Mở hộp thoại quét BLE
  async function doConnectBle(acceptAll = false) {
    if (!navigator.bluetooth) {
      setBleStatus('Trình duyệt không hỗ trợ Web Bluetooth. Hãy mở trang này bằng Bluefy trên iPhone.', false);
      return;
    }
    try {
      setBleStatus('Đang mở hộp thoại quét…', false);
      const options = acceptAll
        ? { acceptAllDevices: true, optionalServices: [SVC] }
        : { filters: [{ namePrefix: 'MotoNav' }, { name: 'MotoNav' }, { services: [SVC] }], optionalServices: [SVC] };

      state.device = await navigator.bluetooth.requestDevice(options);
      state.device.addEventListener('gattserverdisconnected', onDisconnected);
      await openGatt();
    } catch (e) {
      if (e.name === 'NotFoundError' && !acceptAll) {
        setBleStatus("Không lọc được tên 'MotoNav'. Hãy thử bấm nút 'Quét tất cả BLE'.", false);
      } else {
        setBleStatus('Lỗi: ' + e.message, false);
      }
    }
  }

  // Gửi mảng byte xuống BW16 (chia nhỏ thành từng gói 20 byte theo giới hạn BLE MTU)
  async function sendRaw(m) {
    if (!state.rxChar) return;
    if (state.busy) {
      state.queued = m;
      return;
    }
    state.busy = true;
    try {
      const bytes = enc.encode(m);
      for (let i = 0; i < bytes.length; i += 20) {
        const part = bytes.slice(i, i + 20);
        if (state.rxChar.writeValueWithoutResponse) {
          await state.rxChar.writeValueWithoutResponse(part);
        } else {
          await state.rxChar.writeValue(part);
        }
        if (i + 20 < bytes.length) await sleep(15);
      }
    } catch (e) {
      console.warn('Lỗi gửi BLE:', e);
      if (state.device && state.device.gatt && !state.device.gatt.connected) {
        onDisconnected();
      }
    } finally {
      state.busy = false;
    }
    if (state.queued) {
      const q = state.queued;
      state.queued = null;
      sendRaw(q);
    }
  }

  // Gửi thông điệp có lọc trùng lặp
  function send(m, force = false) {
    const sentEl = $('sent');
    if (sentEl) sentEl.textContent = m.trim() || '-';
    if (m === state.lastMsg && !force) return;
    state.lastMsg = m;
    lastFullSendTime = Date.now();
    sendRaw(m);
  }

  function disconnect() {
    if (MotoNav.background && typeof MotoNav.background.stop === 'function') {
      MotoNav.background.stop();
    }
    clearInterval(state.blePingTimer);
    if (state.device && state.device.gatt && state.device.gatt.connected) {
      state.device.gatt.disconnect();
    }
    state.rxChar = null;
    state.device = null;
    setBleStatus('Đã ngắt kết nối', false);
  }

  return {
    doConnectBle,
    disconnect,
    send,
    sendRaw,
    onHeartbeatTick
  };
})();
