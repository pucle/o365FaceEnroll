// app.js — điều phối giao diện: form -> quét mặt kiểu Face ID -> xem lại -> gửi -> hoàn tất.
import { initLandmarker, POSES } from "./pose.js";
import { Q } from "./quality.js";
import { preflight, startCamera, stopCamera, CameraError } from "./camera.js";
import { Scanner, SECTORS, SPAN, R_MIN } from "./scan.js";
import { getConfig, enroll, uploadAll, humanize, gate, wake } from "./upload.js";

const $ = (s) => document.querySelector(s);
const DEBUG = new URLSearchParams(location.search).has("debug");
const STEP = { "screen-gate": 1, "screen-form": 1, "screen-capture": 2, "screen-review": 3, "screen-upload": 3, "screen-done": 4, "screen-error": 0 };
const show = (id) => {
  document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === id)); window.scrollTo(0, 0);
  document.querySelectorAll("#steps li").forEach((li) => { const n = +li.dataset.s, c = STEP[id] || 0; li.classList.toggle("on", n === c); li.classList.toggle("done", n < c); });
};
let gateCode = ""; try { gateCode = sessionStorage.getItem("gate") || ""; } catch {}
const SHORT = { front: "Thẳng", left: "Trái", right: "Phải", up: "Ngẩng", down: "Cúi" };

let cfg = { min_frames: 20, max_frames: 30 };
let info = null, scanner = null, modelReady = false, built = false;
const video = $("#video");

wake((ok) => { $("#conn").textContent = ok ? "" : "Máy chủ đang khởi động (có thể mất ~1 phút ở gói miễn phí)…"; });   // đánh thức backend ngay khi mở trang
show("screen-form");
getConfig().then((c) => {
  cfg = c; if (c.max_side) Q.OUT_MAX = c.max_side; if (c.jpeg_quality) Q.JPEG_Q = c.jpeg_quality;
  if (c.require_code && !gateCode) show("screen-gate");
}).catch(() => {});

$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const code = $("#gate_code").value.trim(), err = $("#gate-err"); err.hidden = true;
  try { await gate(code); gateCode = code; try { sessionStorage.setItem("gate", code); } catch {} show("screen-form"); $("#member_id").focus(); }
  catch (ex) { err.textContent = humanize(ex); err.hidden = false; }
});

function fatal(msg, back = "screen-form") {
  stopCamera(video); if (scanner) scanner.stop();
  $("#err-text").textContent = msg; $("#btn-err-back").onclick = () => show(back); show("screen-error");
}

// Vòng tròn 16 cung quanh khung mặt (SVG, toạ độ -60..60). Cung 0 bắt đầu từ hướng phải, quay theo chiều kim đồng hồ trên màn hình.
const RX = 46, RY = 54, SVG = "http://www.w3.org/2000/svg";
function ringPoint(deg) { const r = deg * Math.PI / 180; return [RX * Math.cos(r), RY * Math.sin(r)]; }
function buildRing() {
  const g = $("#ring"); g.replaceChildren(); const step = 360 / SECTORS;
  // Lớp tối phủ toàn khung, khoét đúng hình elip của vòng (cùng hệ toạ độ SVG nên luôn khớp ở mọi tỉ lệ khung hình).
  const sh = document.createElementNS(SVG, "path"); sh.setAttribute("class", "shade"); const ex = RX + 5, ey = RY + 5;
  sh.setAttribute("d", `M-3000 -3000H3000V3000H-3000Z M${-ex} 0A${ex} ${ey} 0 1 0 ${ex} 0A${ex} ${ey} 0 1 0 ${-ex} 0Z`); g.append(sh);
  for (let i = 0; i < SECTORS; i++) {
    const [x0, y0] = ringPoint(i * step + 2), [x1, y1] = ringPoint((i + 1) * step - 2);
    const p = document.createElementNS(SVG, "path"); p.setAttribute("class", "seg"); p.dataset.i = i;
    p.setAttribute("d", `M${x0.toFixed(2)} ${y0.toFixed(2)} A${RX} ${RY} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`); g.append(p);
  }
  const dot = document.createElementNS(SVG, "circle"); dot.setAttribute("class", "dot"); dot.setAttribute("r", "2.6"); dot.id = "dot"; g.append(dot);
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  info = { member_id: $("#member_id").value.trim(), full_name: $("#full_name").value.trim(), group: $("#group").value.trim(), notes: $("#notes").value.trim(), invite_code: gateCode };
  await beginScan();
});

async function beginScan() {
  try { preflight(); } catch (err) { return fatal(err.message); }
  show("screen-capture"); setHint("Đang tải mô hình nhận diện…", "Lần đầu cần vài giây", "⏳");
  $("#btn-next").hidden = true; $("#stage").classList.remove("done");
  try { if (!modelReady) { await initLandmarker(); modelReady = true; } }
  catch (err) { console.error(err); return fatal("Không tải được mô hình nhận diện khuôn mặt. Hãy mở trang bằng Chrome/Edge (không dùng trình duyệt nhúng trong VS Code), kiểm tra mạng rồi thử lại. Chi tiết: " + String(err.message || err).slice(0, 300)); }
  try { await startCamera(video); }
  catch (err) { return fatal(err instanceof CameraError ? err.message : "Không mở được camera.", "screen-form"); }
  $("#stage").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  if (scanner) { scanner.stop(); scanner.reset(); }
  scanner = new Scanner({ video, cfg, onUpdate: render, onDone: toReview });
  buildRing(); scanner.start();
  video.srcObject.getVideoTracks()[0].addEventListener("ended", () => fatal("Camera bị ngắt. Hãy thử lại."));
}

function setHint(t, sub = "", icon = "◉", tone = "") {
  $("#hint").textContent = t; $("#hint-sub").textContent = sub; $("#hud-icon").textContent = icon;
  $("#hudbox").className = "hud" + (tone ? " " + tone : "");
}

// Nội dung HUD theo trạng thái quét: tiêu đề lớn + câu phụ + biểu tượng + tông màu (ok/warn).
function render(u) {
  const warn = !u.ok && u.hint && !/^(Nhìn thẳng|Xoay|Thêm một vòng)/.test(u.hint);
  let sub = "", icon = "◉";
  if (u.state === "lap") {
    icon = u.ok ? "↻" : (warn ? "!" : "↻");
    sub = u.lap === 1 ? "Xoay đầu thật chậm như vẽ vòng tròn bằng mũi" : `Vòng ${u.lap}: thêm một lượt nữa để lấy nhiều góc hơn`;
  } else { icon = warn ? "!" : "●"; sub = "Giữ yên và nhìn vào camera, hệ thống đang ghi nhận khuôn mặt thẳng"; }
  setHint(u.hint || "", sub, icon, u.ok ? "ok" : (warn ? "warn" : ""));
  $("#oval").classList.toggle("ok", !!u.ok);
  const label = u.state === "lap" ? `Vòng ${u.lap}/2 · ${u.lit.size}/${SECTORS}` : "Bước 1 · nhìn thẳng";
  $("#badge-label").textContent = label;
  document.querySelectorAll("#ring .seg").forEach((p) => p.classList.toggle("on", u.state === "lap" && u.lit.has(+p.dataset.i)));
  const dot = $("#dot");
  if (dot && u.cur) { const k = Math.min(1, 1 / Math.max(u.cur.r, 1e-6)); dot.setAttribute("cx", (u.cur.sx * k * RX).toFixed(1)); dot.setAttribute("cy", (u.cur.sy * k * RY).toFixed(1)); dot.style.opacity = u.state === "lap" ? 1 : 0; }
  const pct = u.state === "lap" ? (((u.lap - 1) * SECTORS + u.lit.size) / (2 * SECTORS)) : (u.frontPct || 0) * 0.05;
  $("#scan-fill").style.width = Math.min(100, pct * 100) + "%";
  $("#btn-next").hidden = !(u.total >= cfg.min_frames && u.elapsed > 8000);       // đủ ảnh mà vẫn chưa xong vòng: cho phép kết thúc sớm
  const d = $("#dbg"); d.hidden = !DEBUG; if (DEBUG) d.textContent = u.dbg || "";
}

$("#btn-next").onclick = () => scanner.finishNow();
$("#btn-cancel").onclick = () => { scanner.stop(); stopCamera(video); if (scanner.items.length) toReview(); else show("screen-form"); };
$("#btn-rescan").onclick = () => { scanner.reset(); beginScan(); };

function toReview() { $("#stage").classList.add("done"); scanner.stop(); stopCamera(video); renderReview(); show("screen-review"); }

function renderReview() {
  const items = scanner.items, total = items.length, missing = Math.max(0, cfg.min_frames - total);
  const by = {}; items.forEach((c) => { by[c.pose] = (by[c.pose] || 0) + 1; });
  $("#review-summary").textContent = `Đã chọn ${total} ảnh (cần tối thiểu ${cfg.min_frames}). Bấm × để loại ảnh xấu.` + (missing ? ` Còn thiếu ${missing} ảnh: bấm "Quét lại".` : "") +
    " Phân bố: " + Object.keys(SHORT).map((k) => `${SHORT[k]} ${by[k] || 0}`).join(", ") + ".";
  const root = $("#review-groups"); root.replaceChildren();
  const grid = document.createElement("div"); grid.className = "grid";
  for (const c of items.slice().sort((a, b) => Object.keys(SHORT).indexOf(a.pose) - Object.keys(SHORT).indexOf(b.pose))) {
    const f = document.createElement("figure"), im = document.createElement("img"); im.src = c.url; im.alt = c.pose;
    const x = document.createElement("button"); x.textContent = "×"; x.title = "Loại ảnh";
    x.onclick = () => { scanner.remove(c.id); renderReview(); };
    f.append(im, x); grid.append(f);
  }
  root.append(grid);
  $("#btn-send").disabled = total < cfg.min_frames; $("#btn-send").textContent = `Gửi ${total} ảnh`;
}

// ---- Gửi ảnh ----
const upCtx = { token: null, member_id: null, refresh: async () => (await enroll(info)).token };
$("#btn-send").onclick = () => doUpload();
$("#btn-retry").onclick = () => doUpload();

async function doUpload() {
  show("screen-upload"); $("#up-error").hidden = true; $("#btn-retry").hidden = true; $("#up-fill").style.width = "0%";
  const pending = scanner.items.filter((i) => !i.uploaded && !i.rejected);
  try {
    if (!upCtx.token) { const r = await enroll(info); upCtx.token = r.token; upCtx.member_id = r.member_id; window.__existing = r.existing_total; }
  } catch (e) { return uploadFailed(humanize(e)); }
  const res = await uploadAll(upCtx, pending, ({ done, total }) => {
    $("#up-fill").style.width = (done / total * 100) + "%"; $("#up-text").textContent = `Đã gửi ${done}/${total} ảnh`;
  });
  if (res.failed.length) return uploadFailed(humanize(res.error) + ` (còn ${res.failed.length} ảnh chưa gửi)`);
  showDone(res.totals);
}

function uploadFailed(msg) {
  const e = $("#up-error"); e.textContent = msg; e.hidden = false; $("#btn-retry").hidden = false;
  if (/hết hạn|không hợp lệ/.test(msg)) upCtx.token = null;
  if (/Mã CLB/.test(msg)) { gateCode = ""; try { sessionStorage.removeItem("gate"); } catch {} $("#up-error").textContent += " Hãy nhập lại mã CLB ở màn hình đầu."; }
}

function showDone(totals) {
  $("#done-text").textContent = `Đã lưu ${scanner.items.filter((i) => i.uploaded).length} ảnh. Cảm ơn bạn đã đóng góp!` + (totals.rejected ? ` (${totals.rejected} ảnh bị từ chối vì không hợp lệ)` : "");
  const ul = $("#done-list"); ul.replaceChildren();
  for (const k of Object.keys(SHORT)) {
    const n = scanner.items.filter((i) => i.uploaded && i.pose === k).length, li = document.createElement("li"); li.textContent = `${SHORT[k]}: ${n} ảnh`; ul.append(li);
  }
  show("screen-done");
}

// Người tiếp theo: xoá form + ảnh + token, giữ nguyên mã CLB đã nhập (không hỏi lại).
$("#btn-next-person").onclick = () => {
  if (scanner) { scanner.stop(); scanner.reset(); }
  upCtx.token = null; upCtx.member_id = null; info = null;
  $("#form").reset(); show("screen-form"); $("#member_id").focus();
};
$("#btn-more").onclick = () => { scanner.reset(); upCtx.token = null; beginScan(); };
