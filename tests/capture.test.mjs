// Test phần thuần của bộ chụp: ước lượng góc từ landmark, cửa sổ tư thế, chia chỉ tiêu, chấm điểm. Chạy: node tests/capture.test.mjs
import { estimateAngles, poseCheck, pitchFrom } from '../static/js/pose.js';
import { computeLimits } from '../static/js/camera.js';
import { Q, qualityScore, judge, sigDistance, cropSquare, faceBox } from '../static/js/quality.js';
let n = 0, bad = 0; const t = (name, c, d) => { n++; if (!c) { bad++; console.log('FAIL', name, d ?? ''); } };
// mặt giả: 478 điểm, đặt các mốc dùng trong estimateAngles. W=H=1000 (x,y chuẩn hoá)
function face({ yaw = 0, noseDy = 0, roll = 0 }) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const half = 0.18, cx = 0.5, set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  set(234, cx - half, 0.5); set(454, cx + half, 0.5);
  set(1, cx + half * 1.2 * Math.tan(yaw * Math.PI / 180), 0.55 + noseDy);                 // mũi dịch theo yaw
  const dy = Math.tan(roll * Math.PI / 180) * 0.2; set(33, 0.4, 0.42 - dy / 2); set(263, 0.6, 0.42 + dy / 2); set(133, 0.45, 0.42 - dy / 4); set(362, 0.55, 0.42 + dy / 4);
  set(152, 0.5, 0.75); return lm;
}
const a0 = estimateAngles(face({}), 1000, 1000); t('front yaw≈0', Math.abs(a0.yaw) < 2, a0.yaw);
const aL = estimateAngles(face({ yaw: 45 }), 1000, 1000); t('left yaw≈45', Math.abs(aL.yaw - 45) < 3, aL.yaw);
const aR = estimateAngles(face({ yaw: -45 }), 1000, 1000); t('right yaw≈-45', Math.abs(aR.yaw + 45) < 3, aR.yaw);
const base = a0.noseRatio; t('baseline pitch 0', Math.abs(pitchFrom(base, base)) < 1e-9);
const f = (y, p = 0, r = 0) => ({ yaw: y, pitch: p, roll: r });
t('front ok', poseCheck('front', f(0)).ok); t('front rejects 30°', !poseCheck('front', f(30)).ok);
t('left ok 45', poseCheck('left', f(45)).ok); t('left rejects front', !poseCheck('left', f(0)).ok); t('left rejects right', !poseCheck('left', f(-45)).ok);
t('right ok', poseCheck('right', f(-45)).ok); t('up ok', poseCheck('up', f(0, 25)).ok); t('down ok', poseCheck('down', f(0, -25)).ok);
t('hint text', /trái/i.test(poseCheck('left', f(0)).hint || ''), poseCheck('left', f(0)).hint);
const L = computeLimits(['front', 'left', 'right', 'up', 'down'], { min_frames: 20, max_frames: 30 });
t('limits sum max=30', Object.values(L).reduce((s, x) => s + x.max, 0) === 30); t('limits min ≥ 4', Object.values(L).every((x) => x.min >= 4));
t('judge dark', judge({ mean: 30, std: 40, over: 0, sharp: 100 }) !== null); t('judge ok', judge({ mean: 130, std: 50, over: 0, sharp: 100 }) === null);
t('score in 0..1', (() => { const s = qualityScore({ w: 0.4 }, { sharp: 80, mean: 130, std: 50 }, 0.8); return s > 0 && s <= 1; })());
t('sig distance', sigDistance([0, 0], [10, 20]) === 15);
const c = cropSquare(faceBox(face({})), 1280, 720); t('crop inside', c.sx >= 0 && c.sy >= 0 && c.sx + c.side <= 1280 && c.sy + c.side <= 720);


// ---- quét kiểu Face ID: hướng -> cung/nhãn ----
const { direction, Scanner, SECTORS } = await import('../static/js/scan.js');
t('dir front', direction({ yaw: 0, pitch: 0 }).pose === 'front');
t('dir left', direction({ yaw: 30, pitch: 0 }).pose === 'left'); t('dir right', direction({ yaw: -30, pitch: 0 }).pose === 'right');
t('dir up', direction({ yaw: 0, pitch: 18 }).pose === 'up'); t('dir down', direction({ yaw: 0, pitch: -18 }).pose === 'down');
const secs = new Set(); for (let k = 0; k < 360; k += 5) secs.add(direction({ yaw: 30 * Math.cos(k * Math.PI / 180), pitch: 18 * Math.sin(k * Math.PI / 180) }).sector);
t('circle covers all 16 sectors', secs.size === SECTORS, secs.size);
t('left is on screen-left', direction({ yaw: 30, pitch: 0 }).sx < 0);

// ---- mô phỏng cả buổi quét với camera/detector giả (DOM giả) ----
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const fakeCtx = { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.from({ length: 128 * 128 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 30 + rnd() * 200)) }) };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx, toBlob: (cb) => cb(new Blob([new Uint8Array([255, 216, 1])], { type: 'image/jpeg' })) }) };
globalThis.URL.createObjectURL ??= () => 'blob:x'; globalThis.URL.revokeObjectURL ??= () => {};
let T = 0, ang = { yaw: 0, pitch: 0 }; const video = { videoWidth: 1000, videoHeight: 1000, readyState: 4, get currentTime() { return T; } };
const updates = []; let done = false;
const sc = new Scanner({ video, cfg: { min_frames: 20, max_frames: 30 }, onUpdate: (u) => updates.push(u), onDone: () => { done = true; },
  detector: () => [face({ yaw: ang.yaw, noseDy: ang.pitch * -0.0035 })] });
// phần face() dùng noseDy: pitch dương (ngẩng) => mũi lên => noseDy âm; baseline sẽ chuẩn hoá nên chỉ cần đúng chiều
let now = 0; const step = async () => { T += 0.1; now += 130; await sc._process(now); };
for (let i = 0; i < 12; i++) await step();                                       // nhìn thẳng
for (let lap = 0; lap < 3 && !done; lap++) for (let k = 0; k < 120 && !done; k++) { const th = (k / 40) * 2 * Math.PI; ang = { yaw: 32 * Math.cos(th), pitch: 20 * Math.sin(th) }; await step(); }
t('scan finished', done, sc.state + ' items=' + sc.items.length);
t('scan items within [20,30]', sc.items.length >= 20 && sc.items.length <= 30, sc.items.length);
const poses = new Set(sc.items.map((c) => c.pose)); t('scan covers all 5 poses', ['front', 'left', 'right', 'up', 'down'].every((p) => poses.has(p)), [...poses]);
console.log(`${n - bad}/${n} test đạt`); process.exit(bad ? 1 : 0);
