/*
 * MotoNav - BW16 (RTL8720DN) + SSD1306 128x32 I2C
 * Nhan du lieu chi duong tu dien thoai qua BLE (Nordic UART-like service)
 *
 * Giao thuc (ASCII, ket thuc bang '\n'):
 *   <dir>|<khoang cach>|<ten duong>\n
 *   dir: L=trai, R=phai, S=thang, U=quay dau, A=den noi, X=het dan duong
 *   vd:  L|250m|Nguyen Hue\n
 *
 * Board: Realtek Ameba Arduino SDK -> "BW16 (RTL8720DN)"
 * Thu vien: U8g2 (cai qua Library Manager)
 * Day noi: VCC->3V3, GND->GND, SDA/SCL -> chan I2C mac dinh cua Wire tren BW16
 *          (thuong la PA26=SDA, PA25=SCL - hay doi chieu voi pinout tren board cua ban)
 */
#include <Wire.h>
#include <U8g2lib.h>
#include "BLEDevice.h"

#define UART_SERVICE_UUID      "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
#define STRING_BUF_SIZE 100

U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

BLEService UartService(UART_SERVICE_UUID);
BLECharacteristic Rx(CHARACTERISTIC_UUID_RX);
BLECharacteristic Tx(CHARACTERISTIC_UUID_TX);
BLEAdvertData advdata;
BLEAdvertData scndata;

// ---- Trang thai dan duong ----
char   navDir = 'X';
String navDist = "";
String navStreet = "";
unsigned long lastRx = 0;
bool   needRedraw = true;
bool   timedOut = true;
bool   wasConnected = false;
unsigned long lastAdvKick = 0;

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

// Thuong BW16 onboard RGB LED la Active HIGH (HIGH = sang).
// Neu board cua ban la loai Active LOW (LOW = sang), chi can doi thanh true:
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

void updateLed() {
  unsigned long now = millis();
  if (now - lastLedBlink > 350) {
    lastLedBlink = now;
    ledBlinkState = !ledBlinkState;
  }

  bool isConnected = BLE.connected(0);

  // 1. Mat ket noi / Cho dien thoai -> Chop Do (Red)
  if (!isConnected || timedOut) {
    setRgb(ledBlinkState, false, false);
    return;
  }

  // 2. Da ket noi BLE nhung chua dan duong ('C' hoac 'X') -> Xanh duong (Blue)
  if (navDir == 'C' || navDir == 'X') {
    setRgb(false, false, true);
    return;
  }

  // 3. Cac trang thai dan duong
  switch (navDir) {
    case 'S': // Di thang -> Xanh la (Green) sang tinh
      setRgb(false, true, false);
      break;
    case 'L': // Re trai -> Chop Vang (Yellow: Do + Xanh la) nhu xi-nhan trai
      setRgb(ledBlinkState, ledBlinkState, false);
      break;
    case 'R': // Re phai -> Chop Cyan (Xanh la + Xanh duong) nhu xi-nhan phai
      setRgb(false, ledBlinkState, ledBlinkState);
      break;
    case 'U': // Quay dau -> Chop Do (Red) canh bao
      setRgb(ledBlinkState, false, false);
      break;
    case 'A': // Den noi -> Sang Trang (White: R + G + B)
      setRgb(true, true, true);
      break;
    default:
      setRgb(false, false, true);
      break;
  }
}

// ---- Bo dem nhan BLE ----
volatile bool hasData = false;
String pending = "";
String lineBuf = "";

const unsigned long TIMEOUT_MS = 8000;
const unsigned long ADV_KICK_MS = 3000;  // khi chua ket noi: cu 3s ep phat quang ba lai (an toan neu dang phat)

void writeCB(BLECharacteristic* chr, uint8_t /*connID*/) {
  if (chr->getDataLen() > 0) {
    pending += chr->readString();
    hasData = true;
  }
}

void notifCB(BLECharacteristic* /*chr*/, uint8_t /*connID*/, uint16_t /*cccd*/) {
  // khong dung notify
}

// ---- Ve mui ten (khung 32x32 ben trai) ----
void bx(bool m, int x, int y, int w, int h) {
  u8g2.drawBox(m ? 32 - x - w : x, y, w, h);
}
void tri(bool m, int x0, int y0, int x1, int y1, int x2, int y2) {
  if (m) { x0 = 31 - x0; x1 = 31 - x1; x2 = 31 - x2; }
  u8g2.drawTriangle(x0, y0, x1, y1, x2, y2);
}

void drawArrow(char d) {
  switch (d) {
    case 'S':
      u8g2.drawBox(13, 12, 6, 20);
      u8g2.drawTriangle(16, 0, 5, 13, 27, 13);
      break;
    case 'L':
    case 'R': {
      bool m = (d == 'R');
      bx(m, 22, 14, 5, 18);   // than dung
      bx(m, 10, 14, 17, 5);   // than ngang
      tri(m, 1, 16, 11, 6, 11, 26);  // dau mui ten
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

void render() {
  u8g2.clearBuffer();
  if (timedOut) {
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav");
    u8g2.drawStr(4, 28, wasConnected ? "Mat tin hieu..." : "Cho dien thoai...");
  } else if (navDir == 'C') {
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav: DA KET NOI");
    u8g2.drawStr(4, 28, "San sang dan duong");
  } else if (navDir == 'X') {
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav");
    u8g2.drawStr(4, 28, "Khong dan duong");
  } else {
    drawArrow(navDir);
    u8g2.setFont(u8g2_font_logisoso16_tr);
    u8g2.drawStr(36, 16, navDist.c_str());
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(36, 30, navStreet.c_str());
  }
  u8g2.sendBuffer();
}

void handleLine(const String& s) {
  int i1 = s.indexOf('|');
  if (i1 < 1) return;
  int i2 = s.indexOf('|', i1 + 1);
  if (i2 < 0) return;
  navDir = s.charAt(0);
  navDist = s.substring(i1 + 1, i2);
  navStreet = s.substring(i2 + 1);
  lastRx = millis();
  timedOut = false;
  needRedraw = true;
}

void setup() {
  Serial.begin(115200);
  initRgb();
  // Khong goi Wire.begin() o day vi u8g2.begin() da tu dong goi Wire.begin().
  // Goi Wire.begin() 2 lan tren SDK AmebaD se gay loi:
  // "Error amb_ard_pin_check_fun. Incorrect pin: 26" do bien SDA_pin bi bien doi thanh PA_26 (26).
  u8g2.begin();
  u8g2.setContrast(255);

  // Goi quang ba chinh: Flags(3) + Ten(9) + UUID128(18) = 30 byte (<= 31). Du de iPhone loc theo ten hoac UUID.
  advdata.addFlags(GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED);
  advdata.addCompleteName("MotoNav");
  advdata.addCompleteServices(BLEUUID(UART_SERVICE_UUID));
  // Scan response: chi ten (iOS xin them goi nay khi quet chu dong)
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
  // QUAN TRONG cho iPhone: ten GAP mac dinh cua thu vien la "AMEBA_BLE_DEV", khac ten quang ba "MotoNav".
  // iOS/Bluefy cache & loc theo ten GAP nen se khong thay thiet bi. Phai dat trung ten truoc beginPeripheral().
  BLE.setDeviceName("MotoNav");
  BLE.configAdvert()->setAdvData(advdata);
  BLE.configAdvert()->setScanRspData(scndata);
  // Dat khoang thoi gian phat quang ba nhanh (50ms - 100ms) de iPhone de bat duoc song
  BLE.configAdvert()->setMinInterval(50);
  BLE.configAdvert()->setMaxInterval(100);
  BLE.configServer(1);
  BLE.addService(UartService);
  BLE.beginPeripheral();

  Serial.println("[BLE] Dang quang ba: MotoNav");
  render();
}

void loop() {
  bool isConnected = BLE.connected(0);
  if (wasConnected && !isConnected) {
    // Ngat ket noi (tat Bluefy, thoat app hoac ra xa) -> Khoi dong lai quang ba BLE
    Serial.println("[BLE] Mat ket noi -> phat lai quang ba");
    delay(50);
    BLE.configAdvert()->startAdv();
    timedOut = true;
    needRedraw = true;
  }
  if (!wasConnected && isConnected) {
    Serial.println("[BLE] Da ket noi thanh cong!");
    navDir = 'C';
    timedOut = false;
    lastRx = millis();
    needRedraw = true;
  }
  wasConnected = isConnected;

  // Watchdog quang ba: iPhone hay huy ket noi giua chung (huy pairing/GATT cache) lam stack dung phat.
  // Chua ket noi thi dinh ky goi startAdv(); neu dang phat thi stack bo qua, khong sao.
  if (!isConnected && millis() - lastAdvKick > ADV_KICK_MS) {
    lastAdvKick = millis();
    BLE.configAdvert()->startAdv();
  }

  if (hasData) {
    String chunk = pending;
    pending = "";
    hasData = false;
    for (unsigned int i = 0; i < chunk.length(); i++) {
      char c = chunk.charAt(i);
      if (c == '\n') {
        handleLine(lineBuf);
        lineBuf = "";
      } else if (c != '\r') {
        if (lineBuf.length() < 80) lineBuf += c;
      }
    }
  }

  if (!timedOut && millis() - lastRx > TIMEOUT_MS) {
    timedOut = true;
    needRedraw = true;
  }

  if (needRedraw) {
    needRedraw = false;
    render();
  }

  updateLed();
  delay(20);
}
