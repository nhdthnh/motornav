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

// ---- Bo dem nhan BLE ----
volatile bool hasData = false;
String pending = "";
String lineBuf = "";

const unsigned long TIMEOUT_MS = 20000;

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
  if (timedOut || navDir == 'X') {
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(4, 14, "MotoNav");
    u8g2.drawStr(4, 28, timedOut ? "Cho dien thoai..." : "Khong dan duong");
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
  // Khong goi Wire.begin() o day vi u8g2.begin() da tu dong goi Wire.begin().
  // Goi Wire.begin() 2 lan tren SDK AmebaD se gay loi:
  // "Error amb_ard_pin_check_fun. Incorrect pin: 26" do bien SDA_pin bi bien doi thanh PA_26 (26).
  u8g2.begin();
  u8g2.setContrast(255);

  advdata.addFlags(GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED);
  advdata.addCompleteName("MotoNav");
  scndata.addCompleteName("MotoNav");
  scndata.addCompleteServices(BLEUUID(UART_SERVICE_UUID));

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
  BLE.configAdvert()->setAdvData(advdata);
  BLE.configAdvert()->setScanRspData(scndata);
  BLE.configServer(1);
  BLE.addService(UartService);
  BLE.beginPeripheral();

  render();
}

void loop() {
  bool isConnected = BLE.connected(0);
  if (wasConnected && !isConnected) {
    // Ngat ket noi (tat Bluefy, thoat app hoac ra xa) -> Khoi dong lai quang ba BLE
    delay(50);
    BLE.configAdvert()->startAdv();
    timedOut = true;
    needRedraw = true;
  }
  wasConnected = isConnected;

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
  delay(20);
}
