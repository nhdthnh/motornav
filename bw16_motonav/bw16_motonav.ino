/*
 * MotoNav - BW16 (RTL8720DN) + OLED 0.96" (128x64) / 0.91" (128x32) I2C
 * Nhận dữ liệu chỉ đường từ điện thoại qua BLE (Nordic UART Service).
 * Hỗ trợ chế độ OFFLINE tự động đếm lùi và chuyển chặng khi iPhone tắt màn hình.
 *
 * ============================================================================
 * CẤU HÌNH PHẦN CỨNG:
 * ============================================================================
 * Board: Realtek Ameba Arduino SDK -> "BW16 (RTL8720DN)"
 * Thư viện: U8g2 (cài đặt qua Library Manager trong Arduino IDE)
 * Dây nối I2C mặc định trên BW16:
 *    VCC  -> 3V3 (hoặc 5V tuỳ module OLED)
 *    GND  -> GND
 *    SDA  -> PA26 (chân SDA mặc định của Wire)
 *    SCL  -> PA25 (chân SCL mặc định của Wire)
 *
 * Chọn loại màn hình bên dưới (1 = OLED 0.96 inch 128x64; 0 = OLED 0.91 inch 128x32):
 */

// ============================================================================
// CHỌN LOẠI MÀN HÌNH OLED
// 1 = OLED 0.96 inch (128x64) - LOẠI 0.96" PHỔ BIẾN NHẤT
// 0 = OLED 0.91 inch (128x32)
// ============================================================================
#define OLED_IS_128X64 1

#include <Wire.h>
#include <U8g2lib.h>
#include "BLEDevice.h"

#define UART_SERVICE_UUID      "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
#define STRING_BUF_SIZE 100

// ---- Cấu hình chế độ Offline khi tắt màn hình ----
#define MAX_PLAN_STEPS        48     // Số chặng tối đa lưu trong RAM
#define PLAN_STREET_LEN       24     // Chiều dài tên đường tối đa
#define TIMEOUT_MS            4000UL // 4s không có dữ liệu/heartbeat -> tự kích hoạt Offline
#define ADV_KICK_MS           3000UL // Định kỳ kích phát quảng bá lại khi chưa kết nối
#define OFFLINE_MIN_SPEED     2.0f   // m/s (~7 km/h)
#define OFFLINE_MAX_SPEED     40.0f  // m/s (~144 km/h)
#define OFFLINE_DEFAULT_SPEED 8.0f   // ~28.8 km/h - tốc độ giả định khi chưa có mẫu GPS

// Khởi tạo đối tượng màn hình OLED SSD1306 I2C
#if OLED_IS_128X64
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
#else
U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
#endif

BLEService UartService(UART_SERVICE_UUID);
BLECharacteristic Rx(CHARACTERISTIC_UUID_RX);
BLECharacteristic Tx(CHARACTERISTIC_UUID_TX);
BLEAdvertData advdata;
BLEAdvertData scndata;

// ---- Trạng thái dẫn đường ----
char     navDir = 'X';
String   navDist = "";
String   navStreet = "";
uint32_t navDistM = 0;
bool     navActive = false;
unsigned long lastRx = 0;
bool     needRedraw = true;
bool     connected = false;
unsigned long lastAdvKick = 0;

// ---- Tính toán vận tốc từ khoảng cách thời gian thực ----
unsigned long lastDistUpdateMs = 0;
uint32_t prevNavDistM = 0;
float    speedMps = 0.0f;

// ---- Chế độ Offline ----
bool     offlineMode = false;
unsigned long lastOfflineTick = 0;
float    estDistM = 0.0f;
uint32_t lastShownDistM = 0xFFFFFFFFUL;

// ---- Lộ trình nạp trước (Offline route fallback) ----
struct PlanStep {
  char     dir;
  uint16_t distM;
  uint16_t durS;
  char     street[PLAN_STREET_LEN];
};
PlanStep plan[MAX_PLAN_STEPS];
uint8_t  planLen = 0;
uint8_t  planIdx = 0;
bool     planReady = false;

// ---- Onboard RGB LED (BW16) ----
#ifndef LED_R
#define LED_R PA12
#endif
#ifndef LED_G
#define LED_G PA14
#endif
#ifndef LED_B
#define LED_B PA13
#endif

const bool LED_ACTIVE_LOW = false;
unsigned long lastLedBlink = 0;
bool ledBlinkState = false;

void setRgb(bool r, bool g, bool b) {
  digitalWrite(LED_R, (r ^ LED_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(LED_G, (g ^ LED_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(LED_B, (b ^ LED_ACTIVE_LOW) ? HIGH : LOW);
}

void initRgb() {
  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  setRgb(false, false, false);
}

bool isGuidanceDir(char d) {
  return d == 'L' || d == 'R' || d == 'S' || d == 'U' || d == 'A';
}

void updateNavActive() {
  navActive = isGuidanceDir(navDir);
}

void updateLed() {
  unsigned long now = millis();
  if (now - lastLedBlink > 350) {
    lastLedBlink = now;
    ledBlinkState = !ledBlinkState;
  }

  // 1. Mất kết nối BLE hoặc đang Offline -> chớp Đỏ cảnh báo
  if (!connected || offlineMode) {
    setRgb(ledBlinkState, false, false);
    return;
  }

  // 2. Đã kết nối nhưng chưa dẫn đường -> Xanh dương
  if (!navActive || navDir == 'C' || navDir == 'X') {
    setRgb(false, false, true);
    return;
  }

  // 3. Trạng thái chỉ dẫn thời gian thực
  switch (navDir) {
    case 'S': // Đi thẳng -> Xanh lá sáng tĩnh
      setRgb(false, true, false);
      break;
    case 'L': // Rẽ trái -> Chớp Vàng xi-nhan
      setRgb(ledBlinkState, ledBlinkState, false);
      break;
    case 'R': // Rẽ phải -> Chớp Cyan xi-nhan
      setRgb(false, ledBlinkState, ledBlinkState);
      break;
    case 'U': // Quay đầu -> Chớp Đỏ
      setRgb(ledBlinkState, false, false);
      break;
    case 'A': // Đến nơi -> Trắng
      setRgb(true, true, true);
      break;
    default:
      setRgb(false, false, true);
      break;
  }
}

// ==========================================================================
//  BỘ ĐỆM NHẬN BLE AN TOÀN (Ring buffer lock-free, không malloc trong ISR)
// ==========================================================================
#define RX_RING_SIZE 512
static uint8_t rxRing[RX_RING_SIZE];
static volatile uint16_t rxHead = 0;
static volatile uint16_t rxTail = 0;
String lineBuf = "";

void writeCB(BLECharacteristic* chr, uint8_t /*connID*/) {
  int len = chr->getDataLen();
  if (len <= 0) return;
  uint8_t* p = chr->getDataBuff();
  if (!p) return;
  for (int i = 0; i < len; i++) {
    uint16_t nextHead = (uint16_t)((rxHead + 1) % RX_RING_SIZE);
    if (nextHead != rxTail) {
      rxRing[rxHead] = p[i];
      rxHead = nextHead;
    }
  }
}

void notifCB(BLECharacteristic* /*chr*/, uint8_t /*connID*/, uint16_t /*cccd*/) {
  // Không dùng notify
}

// ==========================================================================
//  TIỆN ÍCH KHOẢNG CÁCH
// ==========================================================================
// "250m" -> 250, "1.2km" -> 1200
uint32_t parseDistM(const String& s) {
  String t = s;
  t.trim();
  if (!t.length()) return 0;
  bool km = t.endsWith("km") || t.endsWith("KM") || t.endsWith("Km");
  float v = t.toFloat();
  if (v < 0) v = 0;
  float meters = km ? v * 1000.0f : v;
  if (meters > 65000.0f) meters = 65000.0f;
  return (uint32_t)meters;
}

// 1200 -> "1.2km"; 250 -> "250m"
String fmtDistM(uint32_t m) {
  if (m >= 1000UL) {
    uint32_t tenths = (m + 50UL) / 100UL;
    char buf[12];
    snprintf(buf, sizeof(buf), "%lu.%lu", (unsigned long)(tenths / 10UL),
             (unsigned long)(tenths % 10UL));
    return String(buf) + "km";
  }
  return String((unsigned long)m) + "m";
}

// ==========================================================================
//  XỬ LÝ LỘ TRÌNH OFFLINE
// ==========================================================================
void loadPlanEntry(uint8_t idx, bool resetEstimate) {
  if (!planReady || idx >= planLen) return;
  navDir = plan[idx].dir;
  navDistM = plan[idx].distM;
  navDist = fmtDistM(navDistM);
  navStreet = String(plan[idx].street);
  updateNavActive();

  if (resetEstimate) {
    estDistM = (float)navDistM;
    lastShownDistM = navDistM;
  }

  // Tốc độ danh định của chặng = khoảng cách / thời gian
  float nominal = (plan[idx].durS > 0)
      ? ((float)plan[idx].distM / (float)plan[idx].durS) : 0.0f;
  if (nominal > OFFLINE_MIN_SPEED && nominal < OFFLINE_MAX_SPEED) {
    speedMps = (speedMps > OFFLINE_MIN_SPEED)
        ? (speedMps * 0.4f + nominal * 0.6f) : nominal;
  }
  needRedraw = true;
}

void handlePlanLine(const String& s) {
  // PC| : bắt đầu nạp lộ trình mới
  if (s.startsWith("PC")) {
    planLen = 0;
    planIdx = 0;
    planReady = false;
    needRedraw = true;
    return;
  }
  // PE| : chốt lộ trình vừa nạp
  if (s.startsWith("PE")) {
    planReady = (planLen > 0);
    if (planLen > 0 && planIdx >= planLen) planIdx = (uint8_t)(planLen - 1);
    needRedraw = true;
    return;
  }
  // PS|seq : đồng bộ chặng hiện tại
  if (s.startsWith("PS")) {
    int i1 = s.indexOf('|');
    if (i1 < 0) return;
    long n = s.substring(i1 + 1).toInt();
    if (n < 0 || n >= MAX_PLAN_STEPS) return;
    planIdx = (uint8_t)n;
    if (planReady && offlineMode) loadPlanEntry(planIdx, true);
    return;
  }
  // P|seq|dir|distM|durS|street : thêm 1 chặng
  if (s.startsWith("P|")) {
    int i1 = s.indexOf('|');
    int i2 = s.indexOf('|', i1 + 1);
    int i3 = s.indexOf('|', i2 + 1);
    int i4 = s.indexOf('|', i3 + 1);
    int i5 = s.indexOf('|', i4 + 1);
    if (i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0) return;

    long seq = s.substring(i1 + 1, i2).toInt();
    if (seq < 0 || seq >= MAX_PLAN_STEPS) return;

    String dirStr = s.substring(i2 + 1, i3);
    if (!dirStr.length()) return;
    long distM = s.substring(i3 + 1, i4).toInt();
    long durS  = s.substring(i4 + 1, i5).toInt();
    if (distM < 0) distM = 0;
    if (distM > 65000L) distM = 65000L;
    if (durS < 0) durS = 0;
    if (durS > 65000L) durS = 65000L;

    plan[seq].dir   = dirStr.charAt(0);
    plan[seq].distM = (uint16_t)distM;
    plan[seq].durS  = (uint16_t)durS;

    String street = s.substring(i5 + 1);
    street.trim();
    if (street.length() > (PLAN_STREET_LEN - 1)) street = street.substring(0, PLAN_STREET_LEN - 1);
    strncpy(plan[seq].street, street.c_str(), PLAN_STREET_LEN - 1);
    plan[seq].street[PLAN_STREET_LEN - 1] = '\0';

    if ((uint8_t)(seq + 1) > planLen) planLen = (uint8_t)(seq + 1);
    return;
  }
}

void enterOfflineMode() {
  if (offlineMode || !navActive) return;
  offlineMode = true;

  estDistM = (float)navDistM;
  if (estDistM <= 0.5f && planReady && planIdx < planLen) {
    navDir = plan[planIdx].dir;
    navDistM = plan[planIdx].distM;
    navDist = fmtDistM(navDistM);
    navStreet = String(plan[planIdx].street);
    updateNavActive();
    estDistM = (float)navDistM;
  }

  if (speedMps < OFFLINE_MIN_SPEED) {
    float nominal = 0.0f;
    if (planReady && planIdx < planLen && plan[planIdx].durS > 0) {
      nominal = (float)plan[planIdx].distM / (float)plan[planIdx].durS;
    }
    speedMps = (nominal > OFFLINE_MIN_SPEED && nominal < OFFLINE_MAX_SPEED)
        ? nominal : OFFLINE_DEFAULT_SPEED;
  }

  lastOfflineTick = millis();
  lastShownDistM = (uint32_t)estDistM;
  needRedraw = true;
}

void advanceOfflineSegment() {
  // Chuyển sang chặng kế tiếp trong lộ trình đã nạp
  if (planReady && (uint16_t)(planIdx + 1) < planLen) {
    planIdx++;
    loadPlanEntry(planIdx, true);
    return;
  }
  // Đã hết các chặng: giữ nguyên hướng dẫn cuối cùng và hiển thị 0m
  navDistM = 0;
  navDist = "0m";
  estDistM = 0.0f;
  lastShownDistM = 0;
  needRedraw = true;
}

void updateOffline() {
  if (!offlineMode) return;
  if (!navActive || navDir == 'A' || navDir == 'X') return;

  unsigned long now = millis();
  unsigned long dt = now - lastOfflineTick;
  if (dt < 20) return;
  lastOfflineTick = now;
  if (dt > 4000UL) dt = 4000UL;

  estDistM -= speedMps * (float)dt / 1000.0f;
  if (estDistM <= 0.0f) {
    estDistM = 0.0f;
    advanceOfflineSegment();
    return;
  }

  uint32_t shown = ((uint32_t)estDistM / 10UL) * 10UL;
  if (shown != lastShownDistM) {
    lastShownDistM = shown;
    navDistM = (uint32_t)estDistM;
    navDist = fmtDistM(shown);
    needRedraw = true;
  }
}

void noteLiveDistance(uint32_t newDistM) {
  unsigned long now = millis();
  if (navActive && lastDistUpdateMs > 0 && newDistM < prevNavDistM) {
    unsigned long dtms = now - lastDistUpdateMs;
    if (dtms > 250UL && dtms < 15000UL) {
      float sample = (float)(prevNavDistM - newDistM) * 1000.0f / (float)dtms;
      if (sample > OFFLINE_MIN_SPEED && sample < OFFLINE_MAX_SPEED) {
        speedMps = (speedMps > OFFLINE_MIN_SPEED)
            ? (speedMps * 0.7f + sample * 0.3f) : sample;
      }
    }
  }
  prevNavDistM = newDistM;
  lastDistUpdateMs = now;
}

void applyGuidance(char dir, const String& dist, const String& street) {
  navDir = dir;
  navDist = dist;
  navStreet = street;
  navDistM = parseDistM(dist);
  updateNavActive();
  if (navActive) noteLiveDistance(navDistM);

  offlineMode = false;
  lastRx = millis();
  needRedraw = true;

  if (dir == 'X') {
    planReady = false;
    planLen = 0;
    planIdx = 0;
    speedMps = 0.0f;
  }
}

// ==========================================================================
//  XỬ LÝ TỪNG DÒNG LỆNH TỪ APP
// ==========================================================================
void handleLine(const String& s) {
  if (!s.length()) return;

  // Heartbeat định kỳ
  if (s.startsWith("K|")) {
    lastRx = millis();
    return;
  }

  // App báo chuẩn bị vào nền / tắt màn hình -> chuyển Offline ngay
  if (s.startsWith("GO")) {
    lastRx = millis();
    if (navActive) enterOfflineMode();
    return;
  }

  // Xác nhận kết nối
  if (s.startsWith("C|")) {
    lastRx = millis();
    offlineMode = false;
    if (!navActive) {
      navDir = 'C';
      navDist = "";
      navStreet = "";
      navDistM = 0;
      updateNavActive();
    }
    needRedraw = true;
    return;
  }

  // Các gói tin lộ trình Offline
  if (s.startsWith("P")) {
    handlePlanLine(s);
    lastRx = millis();
    return;
  }

  // Gói tin chỉ đường: <dir>|<dist>|<street>
  int i1 = s.indexOf('|');
  if (i1 < 1) return;
  int i2 = s.indexOf('|', i1 + 1);
  if (i2 < 0) return;
  applyGuidance(s.charAt(0), s.substring(i1 + 1, i2), s.substring(i2 + 1));
}

// ==========================================================================
//  VẼ MÀN HÌNH OLED 128X64 (0.96 inch)
// ==========================================================================
#if OLED_IS_128X64

void drawArrow64(char d) {
  const int ox = 2;
  const int oy = 16;
  switch (d) {
    case 'S': // Đi thẳng
      u8g2.drawBox(ox + 13, oy + 12, 6, 20);
      u8g2.drawTriangle(ox + 16, oy + 0, ox + 5, oy + 13, ox + 27, oy + 13);
      break;
    case 'L': // Rẽ trái
      u8g2.drawBox(ox + 14, oy + 14, 5, 18);   // thân đứng
      u8g2.drawBox(ox + 8,  oy + 14, 11, 5);   // thân ngang
      u8g2.drawTriangle(ox + 1, oy + 16, ox + 10, oy + 7, ox + 10, oy + 25);  // đầu mũi tên
      break;
    case 'R': // Rẽ phải
      u8g2.drawBox(ox + 13, oy + 14, 5, 18);   // thân đứng
      u8g2.drawBox(ox + 13, oy + 14, 11, 5);  // thân ngang
      u8g2.drawTriangle(ox + 31, oy + 16, ox + 22, oy + 7, ox + 22, oy + 25); // đầu mũi tên
      break;
    case 'U': // Quay đầu
      u8g2.drawBox(ox + 6, oy + 8, 5, 24);
      u8g2.drawBox(ox + 6, oy + 8, 20, 5);
      u8g2.drawBox(ox + 21, oy + 8, 5, 14);
      u8g2.drawTriangle(ox + 17, oy + 21, ox + 29, oy + 21, ox + 23, oy + 31);
      break;
    case 'A': // Đến nơi
      u8g2.drawDisc(ox + 16, oy + 16, 13);
      u8g2.setDrawColor(0);
      u8g2.drawDisc(ox + 16, oy + 16, 6);
      u8g2.setDrawColor(1);
      break;
    default:
      u8g2.drawFrame(ox + 4, oy + 4, 24, 24);
      break;
  }
}

void renderGuidance64() {
  // 1. Thanh trạng thái đỉnh (Top status bar: y = 0..12)
  u8g2.setFont(u8g2_font_6x10_tr);
  u8g2.drawStr(0, 9, "MotoNav");

  // Vận tốc
  int curKmH = (int)(speedMps * 3.6f + 0.5f);
  if (curKmH > 0 && curKmH < 180) {
    char spdBuf[16];
    snprintf(spdBuf, sizeof(spdBuf), "%d km/h", curKmH);
    u8g2.drawStr(50, 9, spdBuf);
  }

  // Nhãn trạng thái BLE / OFFLINE
  if (offlineMode) {
    u8g2.drawBox(96, 0, 32, 11);
    u8g2.setDrawColor(0);
    u8g2.drawStr(99, 9, "OFF");
    u8g2.setDrawColor(1);
  } else if (connected) {
    u8g2.drawStr(102, 9, "BLE");
  }

  u8g2.drawHLine(0, 12, 128);

  // 2. Khu vực mũi tên & khoảng cách (y = 14..48)
  drawArrow64(navDir);

  // Khoảng cách font to rõ
  u8g2.setFont(u8g2_font_logisoso18_tr);
  u8g2.drawStr(38, 36, navDist.c_str());

  // Số chặng lộ trình
  if (planReady && planLen > 0) {
    u8g2.setFont(u8g2_font_5x7_tr);
    char stepBuf[16];
    snprintf(stepBuf, sizeof(stepBuf), "Chang %d/%d", planIdx + 1, planLen);
    u8g2.drawStr(38, 47, stepBuf);
  }

  // 3. Thanh tên đường dưới đáy (y = 50..64)
  u8g2.drawHLine(0, 50, 128);
  u8g2.setFont(u8g2_font_6x10_tr);
  u8g2.drawStr(0, 62, navStreet.c_str());
}

#else

// ==========================================================================
//  VẼ MÀN HÌNH OLED 128X32 (0.91 inch dự phòng)
// ==========================================================================
void bx(bool m, int x, int y, int w, int h) {
  u8g2.drawBox(m ? 32 - x - w : x, y, w, h);
}
void tri(bool m, int x0, int y0, int x1, int y1, int x2, int y2) {
  if (m) { x0 = 31 - x0; x1 = 31 - x1; x2 = 31 - x2; }
  u8g2.drawTriangle(x0, y0, x1, y1, x2, y2);
}

void drawArrow32(char d) {
  switch (d) {
    case 'S':
      u8g2.drawBox(13, 12, 6, 20);
      u8g2.drawTriangle(16, 0, 5, 13, 27, 13);
      break;
    case 'L':
    case 'R': {
      bool m = (d == 'R');
      bx(m, 22, 14, 5, 18);
      bx(m, 10, 14, 17, 5);
      tri(m, 1, 16, 11, 6, 11, 26);
      break;
    }
    case 'U':
      bx(false, 6, 8, 5, 24);
      bx(false, 6, 8, 20, 5);
      bx(false, 21, 8, 5, 14);
      tri(false, 17, 21, 29, 21, 23, 31);
      break;
    case 'A':
      u8g2.drawDisc(16, 16, 11);
      u8g2.setDrawColor(0);
      u8g2.drawDisc(16, 16, 5);
      u8g2.setDrawColor(1);
      break;
    default:
      u8g2.drawFrame(4, 4, 24, 24);
      break;
  }
}

void renderGuidance32() {
  drawArrow32(navDir);
  u8g2.setFont(u8g2_font_logisoso16_tr);
  u8g2.drawStr(36, 16, navDist.c_str());
  u8g2.setFont(u8g2_font_6x10_tr);
  u8g2.drawStr(36, 30, navStreet.c_str());
  if (offlineMode) {
    u8g2.setFont(u8g2_font_5x7_tr);
    u8g2.drawStr(104, 7, "OFF");
  }
}
#endif

void render() {
  u8g2.clearBuffer();
  bool showGuidance = navActive && navDir != 'C' && navDir != 'X';

  if (showGuidance) {
#if OLED_IS_128X64
    renderGuidance64();
#else
    renderGuidance32();
#endif
  } else if (navDir == 'C' && connected) {
#if OLED_IS_128X64
    u8g2.setFont(u8g2_font_7x14_tr);
    u8g2.drawStr(4, 20, "MotoNav");
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 38, "DA KET NOI BLE");
    u8g2.drawStr(4, 54, "San sang dan duong...");
#else
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav: DA KET NOI");
    u8g2.drawStr(4, 28, "San sang dan duong");
#endif
  } else if (!connected) {
#if OLED_IS_128X64
    u8g2.setFont(u8g2_font_7x14_tr);
    u8g2.drawStr(4, 20, "MotoNav 0.96\"");
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 38, "Cho ket noi...");
    u8g2.drawStr(4, 54, "Mo Bluefy tren iPhone");
#else
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav");
    u8g2.drawStr(4, 28, "Cho dien thoai...");
#endif
  } else {
#if OLED_IS_128X64
    u8g2.setFont(u8g2_font_7x14_tr);
    u8g2.drawStr(4, 20, "MotoNav");
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 38, "Khong dan duong");
#else
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav");
    u8g2.drawStr(4, 28, "Khong dan duong");
#endif
  }
  u8g2.sendBuffer();
}

// ==========================================================================
//  SETUP / LOOP
// ==========================================================================
void setup() {
  Serial.begin(115200);
  initRgb();
  u8g2.begin();
  u8g2.setContrast(255);

  // Gói tin quảng bá BLE (tên MotoNav và UART UUID)
  advdata.addFlags(GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED);
  advdata.addCompleteName("MotoNav");
  advdata.addCompleteServices(BLEUUID(UART_SERVICE_UUID));
  scndata.addCompleteName("MotoNav");

  Rx.setWriteProperty(true);
  Rx.setWriteNRProperty(true);
  Rx.setWritePermissions(GATT_PERM_WRITE);
  Rx.setWriteCallback(writeCB);
  Rx.setBufferLen(STRING_BUF_SIZE);

  Tx.setReadProperty(true);
  Tx.setReadPermissions(GATT_PERM_READ);
  Tx.setNotifyProperty(true);
  Tx.setCCCDCallback(notifCB);
  Tx.setBufferLen(STRING_BUF_SIZE);

  UartService.addCharacteristic(Rx);
  UartService.addCharacteristic(Tx);

  BLE.init();
  BLE.setDeviceName("MotoNav");
  BLE.configAdvert()->setAdvData(advdata);
  BLE.configAdvert()->setScanRspData(scndata);
  BLE.configAdvert()->setMinInterval(50);
  BLE.configAdvert()->setMaxInterval(100);
  BLE.configServer(1);
  BLE.addService(UartService);
  BLE.beginPeripheral();

  Serial.println("[BLE] Dang quang ba: MotoNav");
#if OLED_IS_128X64
  Serial.println("[FW] MotoNav HUD v3 - OLED 0.96 inch 128x64 + Offline Plan");
#else
  Serial.println("[FW] MotoNav HUD v3 - OLED 0.91 inch 128x32 + Offline Plan");
#endif
  render();
}

void onBleConnected() {
  connected = true;
  lastRx = millis();
  offlineMode = false;
  speedMps = 0.0f;
  lastDistUpdateMs = millis();
  prevNavDistM = navDistM;
  if (!navActive) {
    navDir = 'C';
    navDist = "";
    navStreet = "";
    navDistM = 0;
    updateNavActive();
  }
  needRedraw = true;
  Serial.println("[BLE] Da ket noi thanh cong!");
}

void onBleDisconnected() {
  connected = false;
  if (navActive) {
    enterOfflineMode();
  }
  needRedraw = true;
  Serial.println("[BLE] Mat ket noi -> chuyen sang che do Offline (neu dang dan duong)");
}

void loop() {
  bool isConn = BLE.connected(0);

  static bool pendingConn = false;
  static unsigned long pendingSince = 0;
  if (isConn != pendingConn) {
    pendingConn = isConn;
    pendingSince = millis();
  }
  if (pendingConn != connected && (millis() - pendingSince) >= 250UL) {
    if (pendingConn) onBleConnected();
    else onBleDisconnected();
  }

  // Định kỳ kích phát quảng bá lại khi chưa kết nối
  if (!isConn && millis() - lastAdvKick > ADV_KICK_MS) {
    lastAdvKick = millis();
    BLE.configAdvert()->startAdv();
  }

  // Xử lý dữ liệu BLE từ Ring Buffer (thread-safe, không bao giờ crash heap)
  while (rxTail != rxHead) {
    char c = (char)rxRing[rxTail];
    rxTail = (uint16_t)((rxTail + 1) % RX_RING_SIZE);
    if (c == '\n') {
      handleLine(lineBuf);
      lineBuf = "";
    } else if (c != '\r') {
      if (lineBuf.length() < 80) lineBuf += c;
    }
  }

  // Quá timeout không có tín hiệu mới từ iPhone -> tự chuyển Offline
  if (connected && !offlineMode && navActive && navDir != 'A' && navDir != 'X'
      && (millis() - lastRx) > TIMEOUT_MS) {
    enterOfflineMode();
  }

  updateOffline();

  if (needRedraw) {
    needRedraw = false;
    render();
  }

  updateLed();
  delay(10);
}
