// pose.js — MediaPipe Face Landmarker (chạy hoàn toàn trên trình duyệt) + ước lượng góc đầu từ landmark.
// Phiên bản MediaPipe được GHIM CỐ ĐỊNH để không bị vỡ khi thư viện cập nhật.

const VER = "0.10.14";
const GOOGLE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
// Thử lần lượt: bản đặt cùng server (static/vendor/mediapipe, tải bằng scripts/download_mediapipe.py) -> jsdelivr -> unpkg.
const SOURCES = [
  { name: "máy chủ này", base: "/vendor/mediapipe", model: "/vendor/mediapipe/face_landmarker.task" },
  { name: "jsdelivr", base: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`, model: GOOGLE_MODEL },
  { name: "unpkg", base: `https://unpkg.com/@mediapipe/tasks-vision@${VER}`, model: GOOGLE_MODEL },
];

let landmarker = null;
let lastTs = 0;
export let initErrors = [];
// Bản wasm của MediaPipe gọi hàm toàn cục `dbg` để ghi log nhưng không định nghĩa nó -> "dbg is not a function" làm sập cả khởi tạo.
// Định nghĩa sẵn (chỉ ghi console, giữ lại vài dòng cuối để hiện kèm lỗi nếu còn lỗi thật).
export const mpLog = [];
globalThis.dbg = (...a) => { const m = a.map(String).join(" "); mpLog.push(m); if (mpLog.length > 6) mpLog.shift(); console.debug("[mediapipe]", m); };

async function tryInit(src) {
  const { FaceLandmarker, FilesetResolver } = await import(`${src.base}/vision_bundle.mjs`); // nạp động: nguồn lỗi chỉ báo lỗi, không làm hỏng cả trang
  const fileset = await FilesetResolver.forVisionTasks(`${src.base}/wasm`);
  const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: src.model, delegate },
    runningMode: "VIDEO",
    numFaces: 2, // đặt 2 để phát hiện "có nhiều hơn 1 người trong khung"
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { return await make("GPU"); }
  catch (e) { console.warn("GPU delegate lỗi, chuyển sang CPU", e); return await make("CPU"); }
}

export async function initLandmarker() {
  initErrors = [];
  for (const src of SOURCES) {
    try { landmarker = await tryInit(src); console.info("MediaPipe nạp từ", src.name); return; }
    catch (e) { console.warn("MediaPipe lỗi từ", src.name, e); initErrors.push(`${src.name}: ${e && e.message ? e.message : e}${e && e.stack ? " @ " + String(e.stack).split("\n").slice(1, 3).map((x) => x.trim().replace(/^at /, "").slice(0, 90)).join(" ← ") : ""}`); }
  }
  throw new Error(initErrors.join(" | ") + (mpLog.length ? " || log MediaPipe: " + mpLog.join(" / ").slice(0, 300) : ""));
}

/** Trả về mảng các khuôn mặt, mỗi khuôn mặt là mảng 478 landmark {x,y,z} (x,y chuẩn hóa 0..1). */
export function detect(video, nowMs) {
  lastTs = Math.max(nowMs, lastTs + 1); // MediaPipe yêu cầu timestamp tăng dần nghiêm ngặt
  return landmarker.detectForVideo(video, lastTs).faceLandmarks || [];
}

// ---------------------------------------------------------------------------------------------
// ƯỚC LƯỢNG GÓC ĐẦU TỪ LANDMARK (khung hình GỐC, chưa lật gương)
//   Quy ước dấu (theo góc nhìn của NGƯỜI DÙNG):
//     yaw   > 0 : quay mặt sang TRÁI của mình   | < 0 : sang phải
//     pitch > 0 : ngẩng lên                     | < 0 : cúi xuống
//     roll  > 0 : nghiêng đầu sang vai TRÁI     | < 0 : sang phải
//   Hai hằng số bên dưới là xấp xỉ hình học; nếu góc thực tế lệch, mở trang với ?debug=1 để xem
//   yaw/pitch/roll trực tiếp rồi chỉnh CAL cho khớp.
// ---------------------------------------------------------------------------------------------
export const CAL = {
  YAW_K: 1.2,       // mũi nhô ra ~1.2 lần nửa bề rộng mặt: ratio = 1.2 * tan(yaw)
  PITCH_GAIN: 180,  // độ / đơn vị thay đổi của tỉ lệ (mũi - mắt)/(cằm - mắt)
};

export function estimateAngles(lm, W, H) {
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H }); // đổi sang pixel để không méo theo tỉ lệ khung
  const nose = P(1), cheekA = P(234), cheekB = P(454); // 234/454: hai bên má (gần tai)
  const half = (cheekB.x - cheekA.x) / 2;
  if (half < 8) return null;
  // Yaw: mũi lệch khỏi đường giữa hai má bao nhiêu so với nửa bề rộng mặt.
  // Quay mặt sang trái của người dùng => mũi dịch sang PHẢI ảnh gốc => ratio > 0.
  const yawRatio = (nose.x - (cheekA.x + cheekB.x) / 2) / half;
  const yaw = Math.atan(yawRatio / CAL.YAW_K) * 180 / Math.PI;
  // Pitch: vị trí dọc của đầu mũi trong đoạn [đường mắt -> cằm]. Ngẩng lên => tỉ lệ GIẢM.
  // Tỉ lệ khi nhìn thẳng khác nhau theo từng người nên được hiệu chỉnh theo baseline (xem camera.js).
  const e = [P(33), P(263), P(133), P(362)];
  const eyeY = (e[0].y + e[1].y + e[2].y + e[3].y) / 4;
  const faceH = P(152).y - eyeY;
  if (faceH < 8) return null;
  const noseRatio = (nose.y - eyeY) / faceH;
  // Roll: góc đường nối hai khóe mắt ngoài. Mắt bên phải ảnh gốc thấp hơn = nghiêng sang vai trái.
  const roll = Math.atan2(e[1].y - e[0].y, e[1].x - e[0].x) * 180 / Math.PI;
  return { yaw, roll, noseRatio };
}

export const pitchFrom = (noseRatio, base) => (base - noseRatio) * CAL.PITCH_GAIN;

// Mỗi tư thế: cửa sổ góc chấp nhận được (độ). Thực tế ít ai ngẩng/cúi đủ 45° nên cửa sổ rộng hơn mục tiêu.
export const POSES = {
  front:      { label: "Nhìn thẳng vào camera", short: "Thẳng", arrow: "●", win: { yaw: [-12, 12], pitch: [-12, 12], roll: [-15, 15] } },
  left:       { label: "Quay mặt sang TRÁI (~45°)", short: "Trái", arrow: "←", win: { yaw: [25, 65], pitch: [-20, 20], roll: [-25, 25] } },
  right:      { label: "Quay mặt sang PHẢI (~45°)", short: "Phải", arrow: "→", win: { yaw: [-65, -25], pitch: [-20, 20], roll: [-25, 25] } },
  up:         { label: "Ngẩng lên (~45°)", short: "Ngẩng", arrow: "↑", win: { yaw: [-20, 20], pitch: [12, 45], roll: [-20, 20] } },
  down:       { label: "Cúi xuống (~45°)", short: "Cúi", arrow: "↓", win: { yaw: [-20, 20], pitch: [-45, -12], roll: [-20, 20] } },
  tilt_left:  { label: "Nghiêng đầu sang trái nhẹ", short: "Nghiêng T", arrow: "↺", win: { yaw: [-15, 15], pitch: [-15, 15], roll: [10, 35] } },
  tilt_right: { label: "Nghiêng đầu sang phải nhẹ", short: "Nghiêng P", arrow: "↻", win: { yaw: [-15, 15], pitch: [-15, 15], roll: [-35, -10] } },
};

const DIR = {
  yaw: { pos: "Quay mặt sang trái", neg: "Quay mặt sang phải" },
  pitch: { pos: "Ngẩng đầu lên", neg: "Cúi đầu xuống" },
  roll: { pos: "Nghiêng đầu sang trái", neg: "Nghiêng đầu sang phải" },
};

function hintFor(axis, sign, beyondZero) {
  const base = sign > 0 ? DIR[axis].pos : DIR[axis].neg;
  return beyondZero ? `${base} thêm một chút` : `${base} một chút (về chính giữa)`;
}

/** So góc hiện tại với cửa sổ của tư thế. Trả về {ok, score(0..1), hint}. */
export function poseCheck(key, a) {
  const w = POSES[key].win;
  let worst = null, sum = 0;
  for (const axis of ["yaw", "pitch", "roll"]) {
    const [lo, hi] = w[axis], v = a[axis];
    sum += 1 - Math.min(1, Math.abs(v - (lo + hi) / 2) / (hi - lo)); // càng gần tâm cửa sổ càng cao
    let off = 0, hint = null;
    if (v < lo) { off = lo - v; hint = hintFor(axis, +1, lo > 0); }
    else if (v > hi) { off = v - hi; hint = hintFor(axis, -1, hi < 0); }
    if (hint && (!worst || off > worst.off)) worst = { off, hint };
  }
  return { ok: !worst, score: sum / 3, hint: worst ? worst.hint : null };
}
