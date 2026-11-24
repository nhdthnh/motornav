# MotoNav — Dẫn đường xe máy: BW16 (RTL8720DN) + OLED 0.96" (128×64) + Bluefy / iPhone

Ứng dụng web dẫn đường chạy trong **Bluefy** (hoặc trình duyệt có Web Bluetooth trên iPhone), gửi chỉ dẫn rẽ xuống vi điều khiển **BW16** hiển thị trên màn hình **OLED SSD1306 0.96 inch (128×64)** qua kết nối BLE.

Repo gồm 2 phần:

| Phần | Vị trí | Mô tả |
|---|---|---|
| Firmware BW16 | [`bw16_motonav/bw16_motonav.ino`](bw16_motonav/bw16_motonav.ino) | Nhận BLE qua Ring Buffer, giao diện OLED 0.96" 128×64 (mũi tên to 32×32 + khoảng cách + tên đường + tốc độ), tự chạy **chế độ Offline** khi mất tín hiệu |
| Web app | [`index.html`](index.html), [`js/`](js), [`css/`](css) | Tìm kiếm, bản đồ OSRM/Google Maps, GPS, BLE TX queue, **Chế độ Màn hình Đen Bỏ Túi** |

---

## 1. Vì sao tắt màn hình iPhone là mất kết nối?

Đây là cơ chế bảo mật và tiết kiệm pin của hệ điều hành **Apple iOS**:

- WebKit trên iOS không hỗ trợ chuẩn Web Bluetooth. Các trình duyệt như **Bluefy** phải tạo một cầu nối (bridge) native CoreBluetooth cho JavaScript.
- Khi bấm nút nguồn **tắt màn hình hoặc khoá máy**, iOS sẽ đưa toàn bộ tiến trình WKWebView vào trạng thái **đóng băng (suspend)**:
  - JavaScript bị tạm dừng.
  - Bộ định vị Web Geolocation (`watchPosition`) bị ngắt nhận toạ độ vệ tinh.
  - Kết nối Web Bluetooth bị ngắt hoặc không còn dữ liệu truyền qua GATT.
- Vì vậy, một trang web thuần không thể tiếp tục nhận GPS ngầm khi máy đã khoá nếu không có các giải pháp kỹ thuật chuyên biệt.

---

## 2. Giải pháp khắc phục triệt để trong MotoNav

Dự án đã giải quyết vấn đề này bằng **2 giải pháp kết hợp**:

### 🎯 Giải pháp 1: Chế độ Bỏ Túi (Màn hình đen OLED) — *Khuyên dùng tốt nhất khi đi xe*
- Trên giao diện web có nút: **"🌙 Màn hình đen tiết kiệm pin (Chế độ bỏ túi)"**.
- Khi bấm nút này:
  - Màn hình iPhone chuyển sang màu đen tuyền 100% (`#000000`).
  - Trên màn hình OLED của iPhone (từ iPhone X đến các dòng iPhone mới), **các điểm ảnh màu đen được tắt điện hoàn toàn**, mức tiêu thụ pin cực thấp gần như tương đương khi tắt màn hình.
  - Hệ thống tự kích hoạt `Screen WakeLock`, ngăn iOS tự động khoá máy.
  - **Bluetooth và GPS vệ tinh duy trì 100% liên tục**, BW16 nhận toạ độ thời gian thực chính xác từng giây.
  - Chống chạm nhầm khi đút túi quần bằng cơ chế **chạm 2 lần liên tiếp (double-tap)** để mở lại giao diện.

### 🧭 Giải pháp 2: Chế độ Dẫn đường Offline thông minh trên BW16 — *Khi chủ động bấm nút Nguồn*
- Nếu người lái chủ động bấm nút nguồn tắt hẳn màn hình:
  - Ngay trước khi tắt màn hình, web app phát gói lệnh `GO|` báo trước cho BW16.
  - BW16 lập tức kích hoạt **chế độ Offline** (hoặc tự bật sau timeout 4 giây nếu mất kết nối đột ngột).
  - BW16 không bao giờ xoá màn hình, giữ nguyên mũi tên và tự **đếm lùi khoảng cách** dựa theo tốc độ thực tế đo được từ các gói tin trước đó (hoặc tốc độ ước tính theo lộ trình).
  - Khi khoảng cách của chặng hiện tại về `0m`, firmware **tự động nhảy sang chặng kế tiếp** trong lộ trình đã nạp sẵn (tối đa 32 chặng).
  - Góc trên bên phải hiện nhãn **`OFF`** và LED RGB chớp đỏ để báo hiệu đang ước lượng.
  - Khi người dùng **bật lại màn hình iPhone**: Web app tự động kết nối lại BLE trong vòng 1 giây, gửi toạ độ GPS thực tế mới nhất và đồng bộ chặng `PS|seq`, màn hình OLED nhảy về khoảng cách thật và nhãn `OFF` biến mất.

---

## 3. Các nâng cấp mã nguồn

### 3.1. Firmware BW16 (`bw16_motonav.ino`)
- **Tối ưu chuẩn cho OLED 0.96 inch (128×64):**
  - Mũi tên dẫn đường 32×32 to rõ ở bên trái.
  - Khoảng cách số lớn (Font Logisoso 18pt) ở trung tâm.
  - Thanh trạng thái đỉnh: hiển thị nhãn `[BLE]` / `[OFF]`, vận tốc xe (`km/h`).
  - Thanh trạng thái đáy: hiển thị tên đường rõ nét.
  - Có cấu hình `#define OLED_IS_128X64 1` (chuyển về `0` nếu dùng màn hình 0.91" 128×32).
- **Bộ đệm Ring Buffer an toàn (Lock-free):**
  - Tiếp nhận dữ liệu BLE trong ngắt qua bộ đệm vòng tĩnh, không dùng `malloc` hay Arduino `String` trong callback, triệt tiêu 100% hiện tượng sập nguồn/treo vi điều khiển khi gửi lộ trình dài.
- **Rút ngắn Timeout:** Giảm từ 12s xuống **4s** để phản ứng nhanh hơn khi iPhone tắt màn hình.
- **Tự động chuyển chặng:** Hết mét chặng hiện tại tự nhảy sang chặng tiếp theo trong lộ trình 32 bước.

### 3.2. Web App (`js/`)
- **`js/background.js`:**
  - Bộ phát âm thanh im lặng chuẩn PCM WAV 3 giây (Blob URL động) thay cho file data-URI ngắn, giúp tiến trình không bị iOS MediaServerd đóng băng.
  - Tích hợp Web Audio API (`AudioContext`) và AudioSession API (`navigator.audioSession.type = 'playback'`).
  - Web Worker gửi heartbeat định kỳ 2 giây.
- **`js/ble.js`:**
  - Hàng đợi TX (FIFO queue) chia gói 20 byte chuẩn BLE, tự động tái kết nối không cần quét lại thiết bị.
- **`index.html` & `js/app.js`:**
  - Bổ sung nút bấm và lớp phủ **Chế độ Bỏ Túi (Màn hình đen OLED)** với cơ chế mở khoá double-tap.

---

## 4. Giao thức BLE (ASCII kết thúc bằng `\n`)

| Gói tin | Hướng | Chức năng |
|---|---|---|
| `<dir>\|<dist>\|<street>` | App → BW16 | Chỉ dẫn thời gian thực. `dir`: `L` (trái), `R` (phải), `S` (thẳng), `U` (quay đầu), `A` (đến nơi), `X` (dừng) |
| `K\|\|` | App → BW16 | Heartbeat giữ kết nối |
| `C\|OK\|...` | App → BW16 | Xác nhận kết nối |
| `GO\|` | App → BW16 | Báo app sắp tắt màn hình → BW16 chuyển sang Offline ngay lập tức |
| `PC\|` | App → BW16 | Bắt đầu nạp danh sách chặng |
| `P\|seq\|dir\|distM\|durS\|street` | App → BW16 | Nạp 1 chặng vào bộ nhớ (seq = 0, 1, 2...) |
| `PE\|` | App → BW16 | Hoàn tất nạp lộ trình |
| `PS\|seq` | App → BW16 | Đồng bộ chặng hiện tại |

---

## 5. Cấu hình iPhone & Bluefy để đạt độ ổn định cao nhất

1. **Cài đặt trong Bluefy:**
   - Mở ứng dụng Bluefy trên iPhone.
   - Bấm biểu tượng Cài đặt (bánh răng) -> **Allowed BLE Peripherals** -> Bật cho phép thiết bị **MotoNav** kết nối trong nền.
2. **Cài đặt trong iOS:**
   - Vào **Cài đặt iOS** -> **Bluefy**:
     - Vị trí: Chọn **Khi dùng ứng dụng**.
     - Bật **Làm mới ứng dụng trong nền (Background App Refresh)**.
     - Tắt Chế độ nguồn điện thấp (Low Power Mode) khi dẫn đường.
3. **Thao tác khi bắt đầu di chuyển:**
   - Mở web app bằng Bluefy qua đường dẫn HTTPS.
   - Bấm **Kết nối MotoNav** -> Tìm điểm đến -> Bấm **Bắt đầu dẫn đường**.
   - Bấm **"🌙 Màn hình đen tiết kiệm pin (Chế độ bỏ túi)"** rồi đút điện thoại vào túi hoặc túi chống nước.
   - Khi cần xem bản đồ lại: chạm 2 lần vào màn hình iPhone.

---

## 6. Sơ đồ đấu dây BW16 với OLED 0.96"

| Chân OLED SSD1306 | Chân BW16 (RTL8720DN) | Chú thích |
|---|---|---|
| **VCC** | **3V3** (hoặc 5V) | Nguồn cấp màn hình |
| **GND** | **GND** | Nối đất |
| **SDA** | **PA26** | Chân I2C SDA mặc định của AmebaD Wire |
| **SCL** | **PA25** | Chân I2C SCL mặc định của AmebaD Wire |

*Lưu ý:* Mở file `bw16_motonav/bw16_motonav.ino` bằng Arduino IDE, cài thư viện **U8g2** qua Library Manager, chọn board **BW16 (RTL8720DN)** và nạp bình thường.
