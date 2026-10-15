// scan.js — quét mặt kiểu Face ID: xoay đầu chậm theo vòng tròn, mỗi cung của vòng sáng lên khi lấy được ảnh tốt ở hướng đó.
// Không có lệnh "quay trái/phải/ngẩng/cúi" riêng lẻ: người dùng chỉ vẽ một vòng tròn bằng mũi, hệ thống tự gán nhãn tư thế cho từng ảnh.
import { detect, estimateAngles, pitchFrom } from "./pose.js";
import { Q, faceBox, inFrame, cropSquare, regionStats, judge, qualityScore, cropToBlob } from "./quality.js";

export const SECTORS = 16;
export const SPAN = { yaw: 26, pitch: 16 };   // độ xoay "đủ xa" theo từng trục (pitch nhỏ hơn vì ai cũng khó cúi/ngẩng nhiều)
export const R_MIN = 0.55;                    // bán kính chuẩn hoá tối thiểu để tính là "đang ở vành ngoài"
const NEED_LIT = 13;                          // số cung phải sáng để hoàn thành 1 vòng (13/16)
const FRONT_N = 8;                            // số ảnh nhìn thẳng

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Hướng đầu -> toạ độ màn hình (đã soi gương), cung, nhãn tư thế. a = {yaw, pitch} (độ; yaw>0 = quay sang trái người dùng, pitch>0 = ngẩng). */
export function direction(a) {
  const nx = a.yaw / SPAN.yaw, ny = a.pitch / SPAN.pitch;       // chuẩn hoá: người dùng-trái / ngẩng là dương
  const r = Math.hypot(nx, ny);
  const sx = -nx, sy = -ny;                                      // màn hình soi gương: quay trái => dấu chấm sang trái; ngẩng => lên (y âm)
  const ang = (Math.atan2(sy, sx) + 2 * Math.PI) % (2 * Math.PI);
  const sector = Math.floor(ang / (2 * Math.PI / SECTORS)) % SECTORS;
  let pose = "front";
  if (r >= R_MIN) pose = Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? "left" : "right") : (ny > 0 ? "up" : "down");
  return { r, sx, sy, sector, pose };
}

export class Scanner {
  constructor({ video, cfg, onUpdate, onDone, detector }) {
    this.detect = detector || detect;     // tiêm detector giả khi kiểm thử
    this.video = video; this.cfg = cfg; this.onUpdate = onUpdate; this.onDone = onDone;
    this.items = []; this.nextId = 1; this.running = false; this.busy = false;
    this.state = "wait"; this.lap = 1; this.lit = new Set(); this.base = { ratio: [], yaw: [] }; this.front = 0;
    this.t0 = 0; this.lapStart = 0; this.lastTick = 0; this.lastVT = -1;
    this.scratch = document.createElement("canvas"); this.scratch.width = this.scratch.height = 128;
    this.sctx = this.scratch.getContext("2d", { willReadFrequently: true }); this.out = document.createElement("canvas");
  }
  start() {
    if (this.running) return; this.running = true; this.t0 = performance.now();
    const loop = (t) => { if (!this.running) return; requestAnimationFrame(loop); this._tick(t); };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }
  reset() { this.items.forEach((c) => URL.revokeObjectURL(c.url)); this.items = []; this.state = "wait"; this.lap = 1; this.lit.clear(); this.base = { ratio: [], yaw: [] }; this.front = 0; }
  remove(id) { const i = this.items.findIndex((c) => c.id === id); if (i >= 0) { URL.revokeObjectURL(this.items[i].url); this.items.splice(i, 1); } }
  finishNow() { this._finish(); }

  _emit(u) { this.onUpdate({ state: this.state, lap: this.lap, lit: this.lit, total: this.items.length, elapsed: performance.now() - this.lapStart, ...u }); }

  async _tick(t) {
    const v = this.video;
    if (this.busy || v.readyState < 2 || !v.videoWidth) return;
    if (t - this.lastTick < 1000 / 8 || v.currentTime === this.lastVT) return;
    this.lastTick = t; this.lastVT = v.currentTime; this.busy = true;
    try { await this._process(performance.now()); } catch (e) { console.warn("frame", e); } finally { this.busy = false; }
  }

  async _process(now) {
    const v = this.video, W = v.videoWidth, H = v.videoHeight;
    const faces = this.detect(v, now);
    if (faces.length === 0) return this._emit({ hint: "Đưa khuôn mặt vào khung", ok: false });
    if (faces.length > 1) return this._emit({ hint: "Chỉ một người trong khung hình", ok: false });
    const lm = faces[0], box = faceBox(lm);
    if (box.w < Q.MIN_FACE_W) return this._emit({ hint: "Đưa mặt lại gần hơn", ok: false });
    if (!inFrame(box)) return this._emit({ hint: "Đưa mặt vào giữa khung", ok: false });
    const ang = estimateAngles(lm, W, H); if (!ang) return this._emit({ hint: "Đưa mặt vào giữa khung", ok: false });

    // 1) Nhìn thẳng: lấy mốc (baseline) của chính người này rồi chụp vài ảnh chính diện.
    if (this.state === "wait" || this.state === "front") {
      if (this.state === "wait") { this.state = "front"; this.lapStart = now; }
      if (Math.abs(ang.yaw) < 14 && Math.abs(ang.roll) < 18 && ang.noseRatio > 0.15 && ang.noseRatio < 0.8) {
        this.base.ratio.push(ang.noseRatio); this.base.yaw.push(ang.yaw);
        if (this.base.ratio.length > 40) { this.base.ratio.shift(); this.base.yaw.shift(); }
      } else if (this.base.ratio.length < 4) return this._emit({ hint: "Nhìn thẳng vào camera", ok: false });
      if (this.base.ratio.length < 5) return this._emit({ hint: "Nhìn thẳng vào camera, giữ yên một chút", ok: false });
    }
    const a = { yaw: ang.yaw - median(this.base.yaw), pitch: pitchFrom(ang.noseRatio, median(this.base.ratio)) };
    const d = direction(a), cur = { sx: d.sx, sy: d.sy, r: d.r };
    const dbg = `yaw ${a.yaw.toFixed(0)} pitch ${a.pitch.toFixed(0)} r ${d.r.toFixed(2)} cung ${d.sector} ${d.pose}`;

    const crop = cropSquare(box, W, H), st = regionStats(v, crop, this.sctx);
    const issue = judge(st);

    if (this.state === "front") {
      if (d.r >= R_MIN) return this._emit({ hint: "Nhìn thẳng vào camera", ok: false, cur, dbg });
      if (issue) return this._emit({ hint: issue, ok: false, cur, dbg });
      if (this.front < FRONT_N) { await this._put("front", -1, v, crop, qualityScore(box, st, 1 - d.r), st); this.front++; }
      this._emit({ hint: "Nhìn thẳng...", ok: true, cur, dbg, frontPct: this.front / FRONT_N });
      if (this.front >= FRONT_N) { this.state = "lap"; this.lapStart = performance.now(); this.lit.clear(); }
      return;
    }

    // 2) Xoay đầu chậm theo vòng tròn: mỗi cung sáng khi có 1 ảnh đạt ở hướng đó.
    if (d.r < R_MIN) return this._emit({ hint: this.lap === 1 ? "Xoay đầu thật chậm theo vòng tròn" : "Thêm một vòng nữa, chậm thôi", ok: false, cur, dbg });
    if (issue) return this._emit({ hint: /mờ/.test(issue) ? "Xoay chậm hơn một chút" : issue, ok: false, cur, dbg });
    if (!this.lit.has(d.sector)) {
      await this._put(d.pose, d.sector, v, crop, qualityScore(box, st, Math.min(1, d.r)), st);
      this.lit.add(d.sector);
    }
    this._emit({ hint: this.lit.size >= NEED_LIT ? "Tuyệt!" : "Tiếp tục xoay...", ok: true, cur, dbg });
    if (this.lit.size >= NEED_LIT) this._lapDone();
  }

  _lapDone() {
    const enough = this.items.length >= this.cfg.min_frames;
    if (this.lap >= 2 && (enough || this.lap >= 4)) return this._finish();
    this.lap++; this.lit.clear(); this.lapStart = performance.now();
  }

  _finish() {
    this.running = false;
    const max = this.cfg.max_frames;                            // quá nhiều ảnh: bỏ ảnh điểm thấp nhất ở các vòng sau trước
    while (this.items.length > max) {
      let w = -1; this.items.forEach((c, i) => { if (c.sector >= 0 && (w < 0 || c.score < this.items[w].score)) w = i; });
      if (w < 0) break; URL.revokeObjectURL(this.items[w].url); this.items.splice(w, 1);
    }
    this.onDone();
  }

  async _put(pose, sector, v, crop, score, st) {
    const { blob, w, h } = await cropToBlob(v, crop, this.out);
    if (!blob) return;
    this.items.push({ id: this.nextId++, pose, sector, score, quality: score, blob, url: URL.createObjectURL(blob), w, h, sig: st.sig });
  }
}
