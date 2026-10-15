// quality.js — chấm điểm chất lượng khung hình: kích thước mặt, nằm trọn khung, độ nét, ánh sáng.
export const Q = {
  FPS: 6,               // số khung phân tích mỗi giây
  MIN_FACE_W: 0.25,     // bề rộng mặt >= 25% bề rộng khung
  SHARP_MIN: 20,        // variance Laplacian tối thiểu (ảnh 128x128). Chỉnh lại bằng ?debug=1 nếu quá khắt/lỏng
  SHARP_GOOD: 120,
  MEAN_MIN: 60, MEAN_MAX: 210, STD_MIN: 28, OVER_MAX: 0.10,
  MARGIN: 0.30,         // đệm quanh vùng mặt (tổng 30% cạnh lớn nhất)
  OUT_MAX: 384,         // cạnh ảnh gửi đi tối đa (px)
  JPEG_Q: 0.85,
  DUP_MAD: 7,           // sai khác trung bình (0..255) nhỏ hơn mức này = ảnh gần giống nhau
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);

export function faceBox(lm) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export const inFrame = (b) => b.x0 >= 0.01 && b.x1 <= 0.99 && b.y0 >= 0.0 && b.y1 <= 0.995;

/** Vùng crop vuông quanh mặt (có đệm), kẹp trong khung hình. Toạ độ pixel. */
export function cropSquare(b, W, H) {
  let side = Math.max(b.w * W, b.h * H) * (1 + Q.MARGIN);
  side = Math.min(side, W, H);
  const cx = (b.x0 + b.x1) / 2 * W, cy = (b.y0 + b.y1) / 2 * H;
  return { sx: clamp(cx - side / 2, 0, W - side), sy: clamp(cy - side / 2, 0, H - side), side };
}

/**
 * Thống kê vùng mặt trên canvas 128x128 (thang xám):
 *  - sharp: variance của Laplacian (4*c - 4 láng giềng). Ảnh mờ => biên yếu => variance thấp.
 *  - mean/std: độ sáng trung bình và độ tương phản; over: tỉ lệ điểm cháy sáng (>245).
 *  - sig: "chữ ký" 16x16 để phát hiện ảnh gần giống nhau.
 */
export function regionStats(video, crop, ctx) {
  const N = 128;
  ctx.drawImage(video, crop.sx, crop.sy, crop.side, crop.side, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const g = new Float32Array(N * N);
  let sum = 0, over = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g[j] = y; sum += y; if (y > 245) over++;
  }
  const mean = sum / (N * N);
  let vs = 0; for (let j = 0; j < g.length; j++) vs += (g[j] - mean) ** 2;
  let ls = 0, lss = 0, n = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - N] - g[i + N];
    ls += l; lss += l * l; n++;
  }
  const lm = ls / n;
  const sig = new Uint8Array(256);
  for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
    let s = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += g[(by * 8 + y) * N + bx * 8 + x];
    sig[by * 16 + bx] = s / 64;
  }
  return { mean, std: Math.sqrt(vs / (N * N)), over: over / (N * N), sharp: lss / n - lm * lm, sig };
}

/** Trả về câu nhắc (tiếng Việt) nếu ánh sáng/độ nét chưa đạt, ngược lại null. */
export function judge(st) {
  if (st.mean < Q.MEAN_MIN) return "Cần thêm ánh sáng";
  if (st.mean > Q.MEAN_MAX || st.over > Q.OVER_MAX) return "Ánh sáng quá chói, tránh ánh sáng mạnh chiếu thẳng";
  if (st.std < Q.STD_MIN) return "Ánh sáng chưa đều hoặc thiếu tương phản";
  if (st.sharp < Q.SHARP_MIN) return "Giữ yên, ảnh đang bị mờ";
  return null;
}

/** Điểm tổng hợp 0..1 (dùng để xếp hạng khung trong cùng tư thế). */
export function qualityScore(box, st, poseScore) {
  const sSharp = clamp01((st.sharp - Q.SHARP_MIN) / (Q.SHARP_GOOD - Q.SHARP_MIN));
  const sLight = 1 - Math.min(1, Math.abs(st.mean - 135) / 75);
  const sContrast = clamp01((st.std - Q.STD_MIN) / 40);
  const sSize = clamp01((box.w - Q.MIN_FACE_W) / 0.25);
  return 0.35 * sSharp + 0.15 * sLight + 0.10 * sContrast + 0.15 * sSize + 0.25 * poseScore;
}

export function sigDistance(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Cắt vùng mặt, resize (<= OUT_MAX) và nén JPEG. Ảnh lưu KHÔNG lật gương. */
export function cropToBlob(video, crop, canvas) {
  const out = Math.round(Math.min(Q.OUT_MAX, crop.side));
  canvas.width = canvas.height = out;
  canvas.getContext("2d").drawImage(video, crop.sx, crop.sy, crop.side, crop.side, 0, 0, out, out);
  return new Promise((res) => canvas.toBlob((blob) => res({ blob, w: out, h: out }), "image/jpeg", Q.JPEG_Q));
}
