/**
 * MotoNav - Bluetooth Low Energy (BLE) Module
 * Giao tiếp với mạch BW16 (RTL8720DN) qua chuẩn Nordic UART Service.
 *
 * Các nâng cấp chống mất kết nối khi iPhone tắt màn hình:
 *  - Hàng đợi gửi (TX queue) tuần tự, không rơi gói tin khi gửi lộ trình dài.
 *  - Tự động kết nối lại (backoff) khi BLE rớt, và kết nối lại ngay khi màn hình mở.
 *  - Khi kết nối lại: gửi lại lộ trình offline + đồng bộ bước hiện tại xuống OLED.
 *  - Heartbeat K|| giữ firmware không hiểu nhầm là mất tín hiệu.
 */
window.MotoNav = window.MotoNav || {};

MotoNav.ble = (() => {
  const { $, sleep, enc, lockScreen } = MotoNav.utils;
  const state = MotoNav.state;

  const SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const RXU = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
  const CHUNK = 20;          // giới hạn payload BLE mặc định
  const MAX_QUEUE = 220;     // chống tràn bộ nhớ nếu mất kết nối giữa lúc gửi

  let lastFullSendTime = 0;
  let txQueue = [];
  let pumping = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let intentionalDisconnect = false;
  let lastPS = -1;

  function isConnected() {
    return !!(state.device && state.device.gatt && state.device.gatt.connected && state.rxChar);
  }

  // Cập nhật trạng thái kết nối lên UI
  function setBleStatus(text, ok) {
    state.bleConnected = !!ok;
    const bleState = $('bleState'), bleMsg = $('bleMsg'), btnConn = $('btnConn'), btnConnAll = $('btnConnAll');
    if (bleState) {
      bleState.textContent = ok ? '🟢 ĐÃ KẾT NỐI' : '🟠 CHƯA KẾT NỐI';
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

  // ------------------------------------------------------------------
  //  Hàng đợi ghi BLE
  // ------------------------------------------------------------------
  function enqueueLine(line) {
    if (!state.rxChar) return false;
    txQueue.push(line);
    if (txQueue.length > MAX_QUEUE) txQueue.splice(0, txQueue.length - MAX_QUEUE);
    pump();
    return true;
  }

  async function writeLine(line) {
    const ch = state.rxChar;
    if (!ch) throw new Error('Mất đặc tính BLE');
    const bytes = enc.encode(line);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const part = bytes.slice(i, i + CHUNK);
      if (typeof ch.writeValueWithoutResponse === 'function') {
        await ch.writeValueWithoutResponse(part);
      } else {
        await ch.writeValue(part);
      }
      if (i + CHUNK < bytes.length) await sleep(12);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (txQueue.length && state.rxChar) {
      const line = txQueue.shift();
      try {
        await writeLine(line);
      } catch (e) {
        console.warn('[MotoNav] Lỗi ghi BLE:', e && e.message);
        txQueue.unshift(line);
        if (!(state.device && state.device.gatt && state.device.gatt.connected)) onDisconnected();
        break;
      }
      if (txQueue.length) await sleep(10);
    }
    pumping = false;
  }

  // Gửi mảng byte xuống BW16 (giữ API cũ; giờ đi qua hàng đợi)
  function sendRaw(m) {
    return enqueueLine(m);
  }

  // Gửi thông điệp có lọc trùng lặp
  function send(m, force = false) {
    const sentEl = $('sent');
    if (sentEl) sentEl.textContent = m.trim() || '-';
    if (m === state.lastMsg && !force) return;
    state.lastMsg = m;
    lastFullSendTime = Date.now();
    enqueueLine(m);
  }

  // Gửi lộ trình offline xuống BW16: PC| ... P|seq|dir|distM|durS|street ... PE|
  function sendPlan(plan) {
    if (!state.rxChar || !Array.isArray(plan) || !plan.length) return false;
    lastPS = -1;

    enqueueLine('PC|\n');
    plan.forEach((p, i) => {
      const dir = 'LRSUA'.indexOf(p.dir) >= 0 ? p.dir : 'S';
      const distM = Math.max(0, Math.round(p.distM || 0));
      const durS = Math.max(0, Math.round(p.durS || 0));
      const street = String(p.street || '').replace(/[\r\n|]/g, ' ').slice(0, 45);
      enqueueLine('P|' + i + '|' + dir + '|' + distM + '|' + durS + '|' + street + '\n');
    });
    enqueueLine('PE|\n');
    return true;
  }

  // Đồng bộ bước hiện tại của lo trinh offline xuống BW16
  function sendPS(seq) {
    if (typeof seq !== 'number' || seq < 0) return;
    if (seq === lastPS) return;
    lastPS = seq;
    enqueueLine('PS|' + seq + '\n');
  }

  // ------------------------------------------------------------------
  //  Kết nối / kết nối lại
  // ------------------------------------------------------------------
  async function openGatt(isReconnect) {
    if (!state.device) throw new Error('Chưa chọn thiết bị BLE');
    if (state.bleConnecting) return;   // đang kết nối rồi, tránh gọi trùng
    state.bleConnecting = true;

    try {
      const server = await state.device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);
      const rx = await svc.getCharacteristic(RXU);

      state.rxChar = rx;
      state.lastMsg = '';
      lastFullSendTime = Date.now();
      lastPS = -1;
      reconnectAttempts = 0;
      txQueue = [];

      setBleStatus(
        (isReconnect ? 'Đã kết nối lại với ' : 'Đã kết nối thành công với ') + (state.device.name || 'MotoNav'),
        true
      );

      // Kích hoạt chế độ chạy ngầm (Silent Audio + Web Worker) và giữ sáng màn hình
      if (MotoNav.background && typeof MotoNav.background.start === 'function') {
        MotoNav.background.start();
      }
      lockScreen();

      // Xác nhận kết nối lên OLED (firmware không xoá màn hình nếu đang dẫn đường)
      enqueueLine('C|OK|Da ket noi\n');

      // Nếu app không ở trạng thái dẫn đường thì xoá chỉ dẫn cũ trên OLED
      // (tránh trường hợp app khởi động lại mà màn hình còn lộ trình cũ)
      if (!state.navigating) enqueueLine('X||\n');

      // Đồng bộ lại toàn bộ trạng thái dẫn đường xuống OLED:
      //   lộ trình offline + bước hiện tại + chỉ dẫn hiện tại
      try {
        if (MotoNav.navigation && typeof MotoNav.navigation.onBleReady === 'function') {
          MotoNav.navigation.onBleReady(!!isReconnect);
        }
      } catch (e) {
        console.warn('[MotoNav] onBleReady lỗi:', e);
      }

      clearInterval(state.blePingTimer);
      state.blePingTimer = setInterval(onHeartbeatTick, 2500);

      pump();
    } catch (e) {
      // Kết nối nửa vời (iOS đôi khi để gatt.connected=true nhưng không lấy được service)
      try {
        if (state.device && state.device.gatt && state.device.gatt.connected) state.device.gatt.disconnect();
      } catch (_) {}
      state.rxChar = null;
      throw e;
    } finally {
      state.bleConnecting = false;
    }
  }

  function scheduleReconnect() {
    if (intentionalDisconnect || !state.device || reconnectTimer || isConnected()) return;
    const delay = Math.min(800 * Math.pow(1.7, reconnectAttempts), 8000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (intentionalDisconnect || !state.device || isConnected()) return;
      try {
        await openGatt(true);
      } catch (e) {
        console.warn('[MotoNav] Kết nối lại BLE thất bại:', e && e.message);
        scheduleReconnect();
      }
    }, delay);
  }

  // Gọi khi tab/màn hình hoạt động trở lại hoặc khi người dùng bấm nút kết nối:
  // thử kết nối lại ngay (immediate=true nếu đang có cử chỉ người dùng).
  function reconnectNow(immediate) {
    if (!state.device || isConnected() || intentionalDisconnect) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (immediate) {
      setBleStatus('Đang kết nối lại màn hình BW16…', false);
      openGatt(true).catch(e => {
        console.warn('[MotoNav] Kết nối lại ngay thất bại:', e && e.message);
        setBleStatus('Chưa kết nối lại được (' + ((e && e.name) || 'lỗi') +
          '). App vẫn tự thử lại; nếu mãi không được hãy bấm "Quét tất cả BLE" để chọn lại thiết bị.', false);
        scheduleReconnect();
      });
      return;
    }
    scheduleReconnect();
  }

  // Xử lý khi mất kết nối BLE
  function onDisconnected() {
    if (intentionalDisconnect) return;
    state.rxChar = null;
    txQueue = [];
    clearInterval(state.blePingTimer);
    setBleStatus(
      'Mất kết nối BLE. Màn hình OLED đã tự chuyển chế độ offline; app sẽ tự kết nối lại khi mở màn hình…',
      false
    );
    scheduleReconnect();
  }

  // Heartbeat định kỳ gửi xuống BW16 (được gọi bởi Web Worker ngầm hoặc setInterval)
  function onHeartbeatTick() {
    // Hâm nóng audio ngầm + worker mỗi nhịp (nếu iOS lỡ tạm dừng)
    if (MotoNav.background && typeof MotoNav.background.kick === 'function') {
      MotoNav.background.kick();
    }
    if (!state.rxChar) return;

    // Nếu đang gửi lộ trình/queue nhiều thì không chèn heartbeat cho khỏi nghẽn
    if (txQueue.length > 3) return;

    const now = Date.now();
    if (state.navigating && state.curMsg) {
      // Nếu đã hơn 5s chưa gửi gói tin điều hướng (ví dụ đang dừng đèn đỏ hoặc chạy thẳng),
      // gửi lại curMsg với force=true để OLED luôn hiển thị đúng và không bị timeout
      if (now - lastFullSendTime > 5000) {
        send(state.curMsg, true);
      } else {
        sendRaw('K||\n');
      }
    } else {
      sendRaw('K||\n');
    }
  }

  // Mở hộp thoại quét BLE
  async function doConnectBle(acceptAll = false) {
    if (!navigator.bluetooth) {
      setBleStatus('Trình duyệt không hỗ trợ Web Bluetooth. Hãy mở trang này bằng Bluefy trên iPhone.', false);
      return;
    }
    intentionalDisconnect = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    try {
      setBleStatus('Đang mở hộp thoại quét…', false);
      const options = acceptAll
        ? { acceptAllDevices: true, optionalServices: [SVC] }
        : { filters: [{ namePrefix: 'MotoNav' }, { name: 'MotoNav' }, { services: [SVC] }], optionalServices: [SVC] };

      state.device = await navigator.bluetooth.requestDevice(options);
      state.device.addEventListener('gattserverdisconnected', onDisconnected);
      await openGatt(false);
    } catch (e) {
      if (e.name === 'NotFoundError' && !acceptAll) {
        setBleStatus("Không lọc được tên 'MotoNav'. Hãy thử bấm nút 'Quét tất cả BLE'.", false);
      } else if (e.name === 'NotFoundError') {
        setBleStatus('Không tìm thấy thiết bị BLE nào. Kiểm tra BW16 đã bật nguồn.', false);
      } else {
        setBleStatus('Lỗi: ' + e.message, false);
        // Có device rồi nhưng kết nối lỗi -> vẫn thử lại
        scheduleReconnect();
      }
    }
  }

  // Chủ động ngắt kết nối
  function disconnect() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    txQueue = [];
    lastPS = -1;
    if (MotoNav.background && typeof MotoNav.background.stop === 'function') {
      MotoNav.background.stop();
    }
    clearInterval(state.blePingTimer);
    try {
      if (state.device && state.device.gatt && state.device.gatt.connected) {
        state.device.gatt.disconnect();
      }
    } catch (e) {}
    state.rxChar = null;
    state.device = null;
    setBleStatus('Đã ngắt kết nối', false);
    state.bleConnected = false;
  }

  return {
    doConnectBle,
    disconnect,
    send,
    sendRaw,
    sendPlan,
    sendPS,
    onHeartbeatTick,
    onDisconnected,
    reconnectNow,
    isConnected
  };
})();
