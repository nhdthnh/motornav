/**
 * MotoNav - Background Execution & Continuous Heartbeat Module
 * Duy trì kết nối BLE và định vị GPS khi tắt màn hình, khóa máy hoặc chuyển ứng dụng
 * Kết hợp Silent Audio Loop + Web Worker Timer + MediaSession API
 */
window.MotoNav = window.MotoNav || {};

MotoNav.background = (() => {
  // Đoạn âm thanh WAV siêu nhỏ 100% im lặng (78 byte)
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

  let audioEl = null;
  let worker = null;
  let isRunning = false;

  // Khởi tạo phần tử âm thanh chạy ngầm
  function initAudio() {
    if (audioEl) return;
    try {
      audioEl = new Audio(SILENT_WAV);
      audioEl.loop = true;
      audioEl.volume = 0.01; // Cực nhỏ, không làm phiền người dùng

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'MotoNav - Dẫn đường Xe máy',
          artist: 'Đang kết nối màn hình BW16 (Chạy ngầm)',
          album: 'MotoNav GPS HUD'
        });

        navigator.mediaSession.setActionHandler('play', () => {
          if (audioEl) audioEl.play().catch(() => {});
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          // Khi người dùng bấm nút pause trên tai nghe/màn hình khóa, tự động phát lại để giữ chạy ngầm
          if (audioEl && isRunning) {
            setTimeout(() => audioEl.play().catch(() => {}), 500);
          }
        });
      }
    } catch (e) {
      console.warn('Không thể khởi tạo Background Audio:', e);
    }
  }

  // Khởi tạo Web Worker để duy trì Timer chính xác 2s kể cả khi tab bị trình duyệt đóng băng (freeze/throttle)
  function initWorker() {
    if (worker) return;
    try {
      const workerCode = `
        let t = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (t) clearInterval(t);
            t = setInterval(function() {
              self.postMessage('tick');
            }, 2000);
          } else if (e.data === 'stop') {
            if (t) clearInterval(t);
            t = null;
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);

      worker.onmessage = function(e) {
        if (e.data === 'tick') {
          if (MotoNav.ble && typeof MotoNav.ble.onHeartbeatTick === 'function') {
            MotoNav.ble.onHeartbeatTick();
          }
        }
      };
    } catch (e) {
      console.warn('Không thể khởi tạo Web Worker:', e);
    }
  }

  // Bắt đầu chế độ chạy ngầm (gọi sau khi người dùng bấm tương tác Kết nối hoặc Bắt đầu)
  function start() {
    isRunning = true;
    initAudio();
    initWorker();

    if (audioEl) {
      audioEl.play().then(() => {
        console.log('[Background] Silent audio keepalive đã kích hoạt');
      }).catch(err => {
        console.warn('[Background] Chờ tương tác người dùng để phát audio ngầm:', err);
      });
    }

    if (worker) {
      worker.postMessage('start');
    }

    const badge = document.getElementById('bgBadge');
    if (badge) {
      badge.textContent = '⚡ Chạy ngầm: BẬT';
      badge.className = 'pill ok';
    }
  }

  // Dừng chế độ chạy ngầm khi ngắt kết nối hoàn toàn
  function stop() {
    isRunning = false;
    if (audioEl) {
      audioEl.pause();
    }
    if (worker) {
      worker.postMessage('stop');
    }
    const badge = document.getElementById('bgBadge');
    if (badge) {
      badge.textContent = 'Chạy ngầm: TẮT';
      badge.className = 'pill';
    }
  }

  return {
    start,
    stop,
    isRunning: () => isRunning
  };
})();
