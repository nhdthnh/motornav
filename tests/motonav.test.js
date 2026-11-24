/**
 * MotoNav - headless test harness (Node.js, không cần trình duyệt).
 *
 * Nạp chính các file JS chạy trên trình duyệt vào một VM context có giả lập
 * DOM/BLE, rồi kiểm tra:
 *   - Sinh "lộ trình offline" đúng chiều rẽ / tên đường / khoảng cách (OSRM & Google)
 *   - Đồng bộ PS|seq khi vượt chặng, tự nạp lại lộ trình khi hết tầm
 *   - Xử lý đến nơi (A|0m, gửi PC| xoá lộ trình)
 *   - Lưu/khôi phục phiên dẫn đường
 *   - Hàng đợi TX BLE: chia gói 20 byte, đúng thứ tự, chống trùng, kết nối lại
 *
 * Cách chạy (từ thư mục gốc dự án):
 *   node tests/motonav.test.js .
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const JS = path.join(ROOT, 'js');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); return; }
  failures++;
  console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
}
function eq(a, b, name) { ok(a === b, name, { got: a, want: b }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeEl() {
  return {
    textContent: '', className: '', innerHTML: '', value: '', dataset: {}, style: {},
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, classList: { add() {}, remove() {} }
  };
}

function createContext() {
  const store = {};
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl());
      return els.get(id);
    },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    addEventListener() {}, removeEventListener() {},
    head: { appendChild() {} },
    body: makeEl(),
    visibilityState: 'visible'
  };
  const navigator = {
    geolocation: { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} }
  };
  const ctx = {
    document, navigator, localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, Promise, Date, Math, JSON, URL, Blob, Uint8Array,
    __store: store
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['state.js', 'utils.js', 'background.js', 'ble.js', 'navigation.js']) {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
  }
  // Phần audio/worker không thuộc phạm vi test
  ctx.MotoNav.background = { start() {}, stop() {}, kick() {}, isRunning: () => true };
  return ctx;
}

// ===================== Navigation / plan tests =====================
function testPlanOsm() {
  console.log('\n[1] buildPlan() OSRM');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const nav = ctx.MotoNav.navigation;

  state.mapEngine = 'osm';
  state.navigating = true;
  state.dest = { name: 'Diem den', lat: 10.01, lon: 105.01 };
  state.steps = [
    { distance: 100, duration: 20, name: 'Le Loi', maneuver: { type: 'depart', location: [105.0, 10.0] },
      geometry: { coordinates: [[105.0, 10.0], [105.001, 10.0005]] } },
    { distance: 200, duration: 40, name: 'Nguyen Hue', maneuver: { type: 'turn', modifier: 'left', location: [105.001, 10.0005] },
      geometry: { coordinates: [[105.001, 10.0005], [105.002, 10.001]] } },
    { distance: 300, duration: 60, name: 'Pasteur', maneuver: { type: 'turn', modifier: 'right', location: [105.002, 10.001] },
      geometry: { coordinates: [[105.002, 10.001], [105.003, 10.002]] } },
    { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: [105.003, 10.002] },
      geometry: { coordinates: [[105.003, 10.002], [105.003, 10.002]] } }
  ];
  state.k = 0;

  const plan = nav.buildPlan(0, 32);
  eq(plan.length, 3, 'plan có 3 chặng');
  eq(plan[0].dir, 'L', 'plan[0] = rẽ trái');
  eq(plan[0].distM, 100, 'plan[0] khoảng cách = cả đoạn 0 (100m)');
  eq(plan[0].durS, 20, 'plan[0] thời gian = 20s');
  eq(plan[0].street, 'Nguyen Hue', 'plan[0] tên đường lấy từ bước kế');
  eq(plan[1].dir, 'R', 'plan[1] = rẽ phải');
  eq(plan[2].dir, 'A', 'plan[2] = đến nơi');
  eq(plan[2].street, 'Diem den', 'tên đường fallback cho điểm đến');

  const plan2 = nav.buildPlan(1, 32);
  eq(plan2[0].dir, 'R', 'buildPlan(1) bắt đầu từ chặng kế tiếp');
}

function testPlanGoogle() {
  console.log('\n[2] buildPlan() Google (đã sửa lỗi lệch 1 bước)');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const nav = ctx.MotoNav.navigation;

  state.mapEngine = 'google';
  state.navigating = true;
  state.steps = [
    { distance: { value: 100 }, duration: { value: 20 }, maneuver: '', instructions: 'Head north on <b>Le Loi</b>',
      end_location: { lat: () => 10.0005, lng: () => 105.001 } },
    { distance: { value: 200 }, duration: { value: 40 }, maneuver: 'turn-left', instructions: 'Turn left onto <b>Nguyen Hue</b>',
      end_location: { lat: () => 10.001, lng: () => 105.002 } },
    { distance: { value: 300 }, duration: { value: 60 }, maneuver: 'turn-right', instructions: 'Turn right onto <b>Pasteur</b>',
      end_location: { lat: () => 10.002, lng: () => 105.003 } },
    { distance: { value: 0 }, duration: { value: 0 }, maneuver: '', instructions: 'Arrive at destination',
      end_location: { lat: () => 10.002, lng: () => 105.003 } }
  ];
  state.k = 0;
  const plan = nav.buildPlan(0, 32);
  eq(plan.length, 3, 'plan Google có 3 chặng');
  eq(plan[0].dir, 'L', 'Google plan[0] = maneuver của bước KẾ TIẾP');
  eq(plan[0].street, 'Nguyen Hue', 'Google plan[0] tên đường = bước kế tiếp');
  eq(plan[1].dir, 'R', 'Google plan[1] = rẽ phải');
  eq(plan[2].dir, 'A', 'Google plan[2] = đến nơi');
}

function testPlanSyncAndBleOrder() {
  console.log('\n[3] updateNavGuidance() + syncPlanSequence()');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const nav = ctx.MotoNav.navigation;
  const sent = [];
  const ps = [];
  const plans = [];
  ctx.MotoNav.ble = {
    send: (m, f) => { sent.push({ m, f }); },
    sendRaw: m => { sent.push({ m, raw: true }); },
    sendPlan: p => { plans.push(p); return true; },
    sendPS: s => { ps.push(s); },
    onHeartbeatTick() {}
  };

  state.mapEngine = 'osm';
  state.navigating = true;
  state.dest = { name: 'Dich', lat: 10.01, lon: 105.01 };
  state.steps = [
    { distance: 100, duration: 20, name: 'A', maneuver: { type: 'depart', location: [105.0, 10.0] },
      geometry: { coordinates: [[105.0, 10.0], [105.001, 10.0005]] } },
    { distance: 200, duration: 40, name: 'B', maneuver: { type: 'turn', modifier: 'left', location: [105.001, 10.0005] },
      geometry: { coordinates: [[105.001, 10.0005], [105.002, 10.001]] } },
    { distance: 300, duration: 60, name: 'C', maneuver: { type: 'turn', modifier: 'right', location: [105.002, 10.001] },
      geometry: { coordinates: [[105.002, 10.001], [105.003, 10.002]] } },
    { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: [105.003, 10.002] },
      geometry: { coordinates: [[105.003, 10.002], [105.003, 10.002]] } }
  ];
  state.k = 0;

  nav.sendPlanAndSync();
  eq(plans.length, 1, 'gửi lộ trình 1 lần');
  eq(plans[0].length, 3, 'lộ trình gửi có 3 chặng');
  eq(ps[ps.length - 1], 0, 'gửi PS|0 sau lộ trình');

  nav.updateNavGuidance([105.0001, 10.00005]);
  eq(sent.filter(s => s.m && s.m.startsWith('L|')).length, 1, 'gửi chỉ dẫn L');

  nav.updateNavGuidance([105.001, 10.0005]);
  eq(state.k, 1, 'k tăng lên 1');
  eq(ps[ps.length - 1], 1, 'gửi PS|1 khi vượt chặng');
  ok(sent[sent.length - 1].m.startsWith('R|'), 'chỉ dẫn kế tiếp là R', sent[sent.length - 1].m);

  nav.updateNavGuidance([105.002, 10.001]);
  eq(state.k, 2, 'k tăng lên 2');
  nav.updateNavGuidance([105.003, 10.002]);
  ok(!!sent.find(s => s.m && s.m.startsWith('A|0m|')), 'gửi chỉ dẫn đến nơi A|0m');
  ok(sent.some(s => s.raw && s.m === 'PC|\n'), 'xoá lộ trình offline khi đến nơi');
  eq(state.arrived, true, 'đánh dấu đã đến nơi');

  // prepareForBackground: lưu phiên + báo firmware chuyển offline trước khi iOS treo
  state.arrived = false;
  state.navigating = true;
  state.lastPos = null;
  sent.length = 0;
  nav.prepareForBackground();
  ok(sent.some(s => s.raw && s.m === 'GO|\n'), 'gửi lệnh GO| khi màn hình sắp tắt');
  ok(!!ctx.__store['motonav_session_v1'], 'lưu phiên khi chuyển nền');
}

function testPlanRebuild() {
  console.log('\n[4] tự nạp lại lộ trình khi hết tầm');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const nav = ctx.MotoNav.navigation;
  let planSends = 0;
  ctx.MotoNav.ble = {
    send() {}, sendRaw() {},
    sendPlan() { planSends++; return true; },
    sendPS() {}, onHeartbeatTick() {}
  };
  state.mapEngine = 'osm';
  state.navigating = true;
  state.steps = Array.from({ length: 45 }, (_, i) => ({
    distance: 100, duration: 20, name: 'S' + i,
    maneuver: { type: i === 0 ? 'depart' : (i === 44 ? 'arrive' : 'turn'), modifier: 'left', location: [105 + i * 0.001, 10] },
    geometry: { coordinates: [[105 + i * 0.001, 10], [105 + (i + 1) * 0.001, 10]] }
  }));
  state.k = 0;
  nav.sendPlanAndSync();
  eq(planSends, 1, 'nạp lộ trình ban đầu');
  eq(state.plan.length, 32, 'lộ trình giới hạn 32 chặng');
  state.k = 33;
  nav.syncPlanSequence();
  eq(planSends, 2, 'nạp lại khi vượt quá 32 chặng');
  eq(state.planBaseK, 33, 'cập nhật mốc bước của lộ trình mới');
}

function testSession() {
  console.log('\n[5] lưu / khôi phục phiên');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const nav = ctx.MotoNav.navigation;
  state.navigating = true;
  state.dest = { name: 'Ben Thanh', lat: 10.77, lon: 106.69 };
  nav.saveSession();
  ok(!!ctx.__store['motonav_session_v1'], 'đã ghi phiên vào localStorage');
  const s = nav.loadSession();
  eq(s && s.dest.name, 'Ben Thanh', 'đọc lại được phiên');
  nav.clearSession();
  eq(nav.loadSession(), null, 'xoá phiên');
}

// ===================== BLE transport tests =====================
function makeFakeBleDevice() {
  const listeners = {};
  const char = {
    writes: [],
    async writeValueWithoutResponse(bytes) { this.writes.push(Array.from(bytes).map(b => String.fromCharCode(b)).join('')); },
    async writeValue(bytes) { this.writes.push(Array.from(bytes).map(b => String.fromCharCode(b)).join('')); }
  };
  const device = {
    name: 'MotoNav',
    listeners,
    gatt: {
      connected: false,
      async connect() { this.connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async () => char }) }; },
      disconnect() {
        this.connected = false;
        if (listeners.gattserverdisconnected) listeners.gattserverdisconnected();
      }
    },
    addEventListener(ev, fn) { listeners[ev] = fn; }
  };
  return { device, char };
}

async function testBleTransport() {
  console.log('\n[6] hàng đợi TX BLE, chia gói, tự kết nối lại');
  const ctx = createContext();
  const state = ctx.MotoNav.state;
  const { device, char } = makeFakeBleDevice();
  ctx.navigator.bluetooth = { requestDevice: async () => device };

  await ctx.MotoNav.ble.doConnectBle(false);
  eq(ctx.MotoNav.ble.isConnected(), true, 'đã kết nối BLE');
  await wait(120);
  eq(char.writes.join(''), 'C|OK|Da ket noi\nX||\n', 'đã gửi xác nhận kết nối + reset chỉ dẫn cũ');

  const plan = [
    { dir: 'L', distM: 250, durS: 45, street: 'Nguyen Hue' },
    { dir: 'R', distM: 1200, durS: 120, street: 'Le Loi' },
    { dir: 'A', distM: 0, durS: 0, street: 'Diem den' }
  ];
  char.writes.length = 0;
  ctx.MotoNav.ble.sendPlan(plan);
  ctx.MotoNav.ble.sendPS(0);
  ctx.MotoNav.ble.send('L|250m|Nguyen Hue\n', true);
  await wait(600);
  const expected = 'PC|\nP|0|L|250|45|Nguyen Hue\nP|1|R|1200|120|Le Loi\nP|2|A|0|0|Diem den\nPE|\nPS|0\nL|250m|Nguyen Hue\n';
  eq(char.writes.join(''), expected, 'đúng thứ tự, đúng nội dung qua chia gói 20 byte');

  char.writes.length = 0;
  ctx.MotoNav.ble.send('L|250m|Nguyen Hue\n');
  await wait(120);
  eq(char.writes.length, 0, 'chống gửi trùng');

  ctx.MotoNav.ble.send('L|250m|Nguyen Hue\n', true);
  await wait(120);
  ok(char.writes.join('') === 'L|250m|Nguyen Hue\n', 'force gửi lại được');

  char.writes.length = 0;
  device.gatt.connected = false;
  device.listeners.gattserverdisconnected();
  eq(state.bleConnected, false, 'báo mất kết nối');
  await wait(2000);
  eq(ctx.MotoNav.ble.isConnected(), true, 'tự kết nối lại không cần hộp thoại quét');
  eq(state.bleConnected, true, 'báo kết nối lại');
  await wait(80);
  ok(char.writes.join('').includes('C|OK|Da ket noi'), 'gửi lại xác nhận sau khi nối lại');

  ctx.MotoNav.ble.disconnect();
  eq(state.device, null, 'ngắt kết nối chủ động xoá thiết bị');
  if (state.blePingTimer) clearInterval(state.blePingTimer);
}

async function main() {
  testPlanOsm();
  testPlanGoogle();
  testPlanSyncAndBleOrder();
  testPlanRebuild();
  testSession();
  await testBleTransport();
  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
