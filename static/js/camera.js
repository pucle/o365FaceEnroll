// camera.js — mở camera + vòng lặp chụp liên tục, lọc khung tốt theo từng tư thế.
import { detect, estimateAngles, pitchFrom, poseCheck, POSES } from "./pose.js";
import { Q, faceBox, inFrame, cropSquare, regionStats, judge, qualityScore, sigDistance, cropToBlob } from "./quality.js";

export class CameraError extends Error { constructor(code, message) { super(message); this.code = code; } }

const INAPP = /(FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\/|MicroMessenger|TikTok|Messenger)/i;
const inApp = () => INAPP.test(navigator.userAgent || "");
const INAPP_MSG = "Bạn đang mở trong ứng dụng (Zalo/Facebook...). Hãy bấm nút ⋯ rồi chọn 'Mở bằng trình duyệt' (Chrome/Safari) để dùng camera.";

export function preflight() {
  if (!window.isSecureContext) throw new CameraError("insecure", "Trang cần chạy bằng HTTPS thì trình duyệt mới cho dùng camera. Hãy mở đường link https:// do CLB gửi.");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new CameraError("unsupported", inApp() ? INAPP_MSG : "Trình duyệt này không hỗ trợ camera. Hãy dùng Chrome hoặc Safari bản mới.");
  if (typeof WebAssembly !== "object") throw new CameraError("unsupported", "Trình duyệt không hỗ trợ WebAssembly. Hãy dùng Chrome hoặc Safari bản mới.");
}

function mapError(e) {
  const n = e && e.name;
  if (n === "NotAllowedError" || n === "SecurityError")
    return new CameraError("denied", "Bạn đã chặn quyền camera. Hãy cho phép camera cho trang này trong cài đặt trình duyệt rồi tải lại trang." + (inApp() ? " " + INAPP_MSG : ""));
  if (n === "NotFoundError" || n === "OverconstrainedError") return new CameraError("nocamera", "Không tìm thấy camera trên thiết bị.");
  if (n === "NotReadableError" || n === "AbortError") return new CameraError("busy", "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.");
  return new CameraError("unknown", "Không mở được camera: " + (e && e.message ? e.message : n));
}

export async function startCamera(video) {
  stopCamera(video);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) { throw mapError(e); }
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  return stream;
}

export function stopCamera(video) {
  const s = video.srcObject;
  if (s) s.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Chia chỉ tiêu ảnh cho từng tư thế: tổng tối đa = max_frames, tổng tối thiểu >= min_frames. */
export function computeLimits(poses, cfg) {
  const n = poses.length, base = Math.floor(cfg.max_frames / n), extra = cfg.max_frames - base * n;
  const min = Math.ceil(cfg.min_frames / n), out = {};
  poses.forEach((p, i) => {
    const max = base + (i === 0 ? extra : 0); // phần dư dồn vào tư thế đầu (nhìn thẳng)
    out[p] = { min: Math.min(min, max), max, cap: Math.ceil(max * 1.5) }; // cap: thu dư 50% rồi chọn top-N
  });
  return out;
}

export class Collector {
  constructor({ video, cfg, poses, onUpdate, onPoseDone }) {
    this.video = video; this.poses = poses; this.onUpdate = onUpdate; this.onPoseDone = onPoseDone;
    this.limits = computeLimits(poses, cfg);
    this.pools = Object.fromEntries(poses.map((p) => [p, []]));
    this.baseSamples = [];   // tỉ lệ mũi khi nhìn thẳng của CHÍNH người này (baseline cho pitch)
    this.pose = null; this.running = false; this.busy = false;
    this.lastTick = 0; this.lastVideoTime = -1; this.nextId = 1; this.armAt = 0; this.phaseStart = 0;
    this.scratch = document.createElement("canvas"); this.scratch.width = this.scratch.height = 128;
    this.sctx = this.scratch.getContext("2d", { willReadFrequently: true });
    this.out = document.createElement("canvas");
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => { if (!this.running) return; requestAnimationFrame(loop); this._tick(t); };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  startPose(p) {
    this.pose = p; this.phaseStart = performance.now(); this.armAt = this.phaseStart + 1500; // 1.5s để người dùng kịp chuyển tư thế
    this._emit({ ok: false, hint: `Chuẩn bị: ${POSES[p].label}`, grace: true });
  }

  finishPose() {
    const p = this.pose; if (!p) return;
    const pool = this.pools[p], L = this.limits[p];
    pool.sort((a, b) => b.score - a.score);              // giữ top-N theo điểm
    for (const c of pool.splice(L.max)) URL.revokeObjectURL(c.url);
    pool.sort((a, b) => a.id - b.id);
    this.pose = null;
    this.onPoseDone(p);
  }

  progress() { return Object.fromEntries(this.poses.map((p) => [p, { have: this.pools[p].length, ...this.limits[p] }])); }
  allImages() { return this.poses.flatMap((p) => this.pools[p]); }
  removeImage(pose, id) {
    const pool = this.pools[pose], i = pool.findIndex((c) => c.id === id);
    if (i >= 0) { URL.revokeObjectURL(pool[i].url); pool.splice(i, 1); }
  }
  reset() { for (const p of this.poses) { this.pools[p].forEach((c) => URL.revokeObjectURL(c.url)); this.pools[p] = []; } this.pose = null; }

  _emit(u) {
    const p = this.pose;
    this.onUpdate({ pose: p, have: p ? this.pools[p].length : 0, ...(p ? this.limits[p] : {}),
                    elapsed: performance.now() - this.phaseStart, ...u });
  }

  async _tick(t) {
    const v = this.video;
    if (!this.pose || this.busy || v.readyState < 2 || !v.videoWidth) return;
    if (t - this.lastTick < 1000 / Q.FPS || v.currentTime === this.lastVideoTime) return;
    this.lastTick = t; this.lastVideoTime = v.currentTime; this.busy = true;
    try { await this._process(performance.now()); }
    catch (e) { console.warn("frame error", e); }
    finally { this.busy = false; }
  }

  async _process(now) {
    const v = this.video, W = v.videoWidth, H = v.videoHeight, pose = this.pose;
    const pool = this.pools[pose], L = this.limits[pose];
    const bad = (hint, extra = {}) => this._emit({ ok: false, hint, ...extra });
    if (now < this.armAt) return bad(`Chuẩn bị: ${POSES[pose].label}`, { grace: true });

    const faces = detect(v, now);
    if (faces.length === 0) return bad("Không thấy khuôn mặt. Đưa mặt vào khung oval");
    if (faces.length > 1) return bad("Chỉ để một người trong khung hình");
    const lm = faces[0], box = faceBox(lm);
    if (box.w < Q.MIN_FACE_W) return bad("Đưa mặt lại gần camera hơn");
    if (!inFrame(box)) return bad("Đưa mặt vào giữa khung, đừng để bị cắt");
    const ang = estimateAngles(lm, W, H);
    if (!ang) return bad("Đưa mặt vào giữa khung");

    // Baseline pitch: thu tỉ lệ mũi khi người dùng nhìn thẳng (giai đoạn "front").
    if (pose === "front" && Math.abs(ang.yaw) < 12 && Math.abs(ang.roll) < 15 && ang.noseRatio > 0.15 && ang.noseRatio < 0.8) {
      this.baseSamples.push(ang.noseRatio); if (this.baseSamples.length > 40) this.baseSamples.shift();
    }
    if (this.baseSamples.length < 6) return bad("Nhìn thẳng vào camera và giữ yên...");
    const a = { yaw: ang.yaw, roll: ang.roll, pitch: pitchFrom(ang.noseRatio, median(this.baseSamples)) };
    const dbg = `yaw ${a.yaw.toFixed(0)} pitch ${a.pitch.toFixed(0)} roll ${a.roll.toFixed(0)} | w ${(box.w * 100).toFixed(0)}%`;

    const pc = poseCheck(pose, a);
    if (!pc.ok) return bad(pc.hint, { dbg });

    const crop = cropSquare(box, W, H), st = regionStats(v, crop, this.sctx);
    const dbg2 = `${dbg} | sharp ${st.sharp.toFixed(0)} mean ${st.mean.toFixed(0)} std ${st.std.toFixed(0)}`;
    const issue = judge(st);
    if (issue) return bad(issue, { dbg: dbg2 });

    const score = qualityScore(box, st, pc.score);
    const dup = pool.findIndex((c) => sigDistance(c.sig, st.sig) < Q.DUP_MAD); // loại khung gần giống nhau
    let added = false;
    if (dup >= 0) {
      if (pool[dup].score < score) { await this._put(pool, dup, v, crop, score, st.sig, pose); added = true; }
    } else if (pool.length < L.cap) {
      await this._put(pool, -1, v, crop, score, st.sig, pose); added = true;
    } else {
      let w = 0; pool.forEach((c, i) => { if (c.score < pool[w].score) w = i; });
      if (pool[w].score < score) { await this._put(pool, w, v, crop, score, st.sig, pose); added = true; }
    }
    this._emit({ ok: true, hint: added ? "Tốt! Giữ nguyên, rồi xoay nhẹ để lấy thêm góc" : "Tốt! Hãy xoay mặt nhẹ để chụp thêm góc khác", dbg: dbg2, added });
    if (pool.length >= L.cap) this.finishPose();
  }

  async _put(pool, idx, v, crop, score, sig, pose) {
    const { blob, w, h } = await cropToBlob(v, crop, this.out);
    if (!blob) return;
    const item = { id: this.nextId++, pose, score, quality: score, blob, url: URL.createObjectURL(blob), w, h, sig };
    if (idx >= 0) { URL.revokeObjectURL(pool[idx].url); pool[idx] = item; } else pool.push(item);
  }
}
