/**
 * MotoNav - Background Execution & Continuous Keep-Alive Module
 * Duy trì kết nối BLE và tiến trình định vị khi tắt màn hình, khoá máy hoặc chuyển app:
 *  - Bộ phát âm thanh im lặng (Silent Audio Track 3s WAV chuẩn PCM).
 *  - Web Audio API (AudioContext) giữ luồng âm thanh cấp hệ thống iOS.
 *  - AudioSession API (WebKit iOS 16.4+) thiết lập chế độ 'playback'.
 *  - MediaSession API cập nhật điều khiển đa phương tiện tại màn hình khoá.
 *  - Web Worker chạy ngầm độc lập gửi nhịp Heartbeat 2s.
 */
window.MotoNav = window.MotoNav || {};

MotoNav.background = (() => {
  let audioEl = null;
  let audioCtx = null;
  let oscillator = null;
  let worker = null;
  let isRunning = false;
  let unlockAttached = false;
  let silentWavUrl = null;

  // Tạo file WAV im lặng chuẩn 3 giây (8000Hz, 8-bit PCM) dưới dạng Blob URL.
  // Khác với file data:URI siêu ngắn (vài chục byte), file 3 giây chuẩn này
  // được iOS MediaServerd công nhận là luồng phát thực sự và không bị ngắt khi khoá máy.
  function getSilentWavUrl() {
    if (silentWavUrl) return silentWavUrl;
    try {
      const seconds = 3;
      const sampleRate = 8000;
      const numSamples = sampleRate * seconds;
      const buffer = new ArrayBuffer(44 + numSamples);
      const view = new DataView(buffer);

      // RIFF chunk
      view.setUint32(0, 0x52494646, false); // "RIFF"
      view.setUint32(4, 36 + numSamples, true);
      view.setUint32(8, 0x57415645, false); // "WAVE"
      // fmt chunk
      view.setUint32(12, 0x666d7420, false); // "fmt "
      view.setUint32(16, 16, true);          // Subchunk1Size (16 for PCM)
      view.setUint16(20, 1, true);           // AudioFormat (1 = PCM)
      view.setUint16(22, 1, true);           // NumChannels (1 = Mono)
      view.setUint32(24, sampleRate, true);  // SampleRate
      view.setUint32(28, sampleRate, true);  // ByteRate (sampleRate * 1 * 1)
      view.setUint16(32, 1, true);           // BlockAlign (1 byte)
      view.setUint16(34, 8, true);           // BitsPerSample (8 bit)
      // data chunk
      view.setUint32(36, 0x64617461, false); // "data"
      view.setUint32(40, numSamples, true);

      // Trong 8-bit PCM: giá trị 128 (0x80) biểu diễn biên độ 0 (im lặng tuyệt đối)
      const bytes = new Uint8Array(buffer, 44, numSamples);
      bytes.fill(128);

      const blob = new Blob([buffer], { type: 'audio/wav' });
      silentWavUrl = URL.createObjectURL(blob);
      return silentWavUrl;
    } catch (e) {
      console.warn('[Background] Lỗi tạo Blob WAV:', e);
      // Fallback data URI
      return 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';
    }
  }

  // Cập nhật trạng thái phát cho màn hình khoá (MediaSession)
  function updatePlaybackState() {
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = (audioEl && !audioEl.paused) ? 'playing' : 'paused';
      }
    } catch (e) {}
  }

  // Bật AudioSession của WebKit (iOS 16.4+) sang chế độ playback để iOS
  // không treo luồng âm thanh khi màn hình khoá.
  function configureAudioSession() {
    try {
      if (navigator.audioSession && typeof navigator.audioSession === 'object') {
        navigator.audioSession.type = 'playback';
      }
    } catch (e) {}
  }

  // Khởi tạo Web Audio API để giữ kênh âm thanh phần cứng
  function initWebAudio() {
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;
      if (!audioCtx) {
        audioCtx = new AudioCtxClass();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if (!oscillator && audioCtx) {
        // Tần số cực thấp 20Hz, biên độ 0.00001 (hoàn toàn không nghe thấy nhưng giữ active pipeline)
        oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.00001;
        oscillator.frequency.value = 20;
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
      }
    } catch (e) {
      // Bỏ qua nếu trình duyệt không hỗ trợ Web Audio
    }
  }

  // Khởi tạo phần tử âm thanh chạy ngầm
  function initAudio() {
    if (audioEl) return;
    try {
      const src = getSilentWavUrl();
      audioEl = new Audio(src);
      audioEl.loop = true;
      audioEl.volume = 0.05; // Mức nhỏ, không làm phiền người dùng
      audioEl.setAttribute('playsinline', '');
      audioEl.setAttribute('preload', 'auto');

      // Nếu iOS tạm dừng audio (do khoá máy, cuộc gọi...) thì tự bật lại
      audioEl.addEventListener('pause', () => {
        updatePlaybackState();
        if (isRunning) setTimeout(ensureAudioPlaying, 500);
      });
      audioEl.addEventListener('play', updatePlaybackState);

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'MotoNav - Dẫn đường BW16',
          artist: 'Đang kết nối màn hình OLED (Chạy ngầm)',
          album: 'MotoNav GPS HUD'
        });

        const resume = () => {
          if (isRunning) ensureAudioPlaying();
        };
        navigator.mediaSession.setActionHandler('play', resume);
        navigator.mediaSession.setActionHandler('pause', resume);
        try { navigator.mediaSession.setActionHandler('stop', resume); } catch (e) {}
      }
    } catch (e) {
      console.warn('Không thể khởi tạo Background Audio:', e);
    }
  }

  // Thử lại khi có tương tác chạm nếu iOS chặn autoplay
  function attachUnlockOnGesture() {
    if (unlockAttached) return;
    unlockAttached = true;
    const handler = () => {
      unlockAttached = false;
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('touchstart', handler, true);
      ensureAudioPlaying();
      initWebAudio();
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('touchstart', handler, true);
  }

  function ensureAudioPlaying() {
    if (!isRunning) return;
    if (audioCtx && audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (_) {}
    }
    if (!audioEl) initAudio();
    if (audioEl && audioEl.paused) {
      try {
        const p = audioEl.play();
        if (p && typeof p.then === 'function') {
          p.then(updatePlaybackState).catch(err => {
            console.warn('[Background] Cần cử chỉ chạm để phát audio ngầm:', err && err.message);
            attachUnlockOnGesture();
          });
        }
      } catch (e) {
        console.warn('[Background] Audio play lỗi:', e);
      }
    } else {
      updatePlaybackState();
    }
  }

  // Khởi tạo Web Worker để duy trì Timer chính xác 2s kể cả khi tab bị throttle
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

      worker.onmessage = function (e) {
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

  // Bắt đầu chế độ chạy ngầm
  function start() {
    isRunning = true;
    configureAudioSession();
    initAudio();
    initWebAudio();
    initWorker();

    ensureAudioPlaying();

    if (worker) {
      worker.postMessage('start');
    }

    const badge = document.getElementById('bgBadge');
    if (badge) {
      badge.textContent = '⚡ Chạy ngầm: BẬT';
      badge.className = 'pill ok';
    }
  }

  // Kích hoạt lại khi màn hình mở lại
  function kick() {
    if (!isRunning) return;
    configureAudioSession();
    initWebAudio();
    ensureAudioPlaying();
    if (worker) worker.postMessage('start');
  }

  // Dừng chế độ chạy ngầm khi ngắt kết nối hoàn toàn
  function stop() {
    isRunning = false;
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
    }
    if (oscillator) {
      try { oscillator.stop(); } catch (_) {}
      oscillator = null;
    }
    if (audioCtx) {
      try { audioCtx.suspend(); } catch (_) {}
    }
    if (worker) {
      worker.postMessage('stop');
    }
    updatePlaybackState();
    const badge = document.getElementById('bgBadge');
    if (badge) {
      badge.textContent = 'Chạy ngầm: TẮT';
      badge.className = 'pill';
    }
  }

  return {
    start,
    stop,
    kick,
    isRunning: () => isRunning
  };
})();
