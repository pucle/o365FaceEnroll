// upload.js — gọi API, gửi ảnh theo lô nhỏ, tự thử lại khi mạng yếu.
const API = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

async function req(path, opts = {}, timeoutMs = 45000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(API + path, { ...opts, signal: ac.signal });
    if (!r.ok) {
      let d = r.statusText;
      try { const j = await r.json(); d = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
      throw new ApiError(r.status, d);
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

export const getConfig = () => req("/api/config");
export const gate = (code) => req("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
/** Đánh thức backend (Render free ngủ sau 15 phút): gọi /healthz tới khi có phản hồi, báo trạng thái qua cb(ok). */
export async function wake(cb) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(API + "/healthz", { cache: "no-store" }); cb(true); return r.ok; } catch { cb(false); await new Promise((r) => setTimeout(r, 3000)); }
  }
  return false;
}
// Đăng ký thành viên -> token tải ảnh (HMAC, 2 giờ). Trả {token, existing_total} như giao diện cũ.
export const enroll = async (info) => {
  const r = await req("/api/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: info.member_id, full_name: info.full_name, group: info.group || null, notes: info.notes || null, invite_code: info.invite_code || null }) });
  return { token: r.upload_token, existing_total: r.existing_images, member_id: r.member_id };
};

export function humanize(e) {
  if (e instanceof ApiError) {
    if (e.status === 429) return "Bạn thao tác quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
    if (e.status === 413) return "Dữ liệu gửi quá lớn.";
    if (e.status === 422) return "Thông tin không hợp lệ. Kiểm tra lại mã thành viên và họ tên.";
    if (e.status === 401) return "Phiên đăng ký đã hết hạn. Hãy bấm gửi lại.";
    if (e.status === 403) return e.message || "Không được phép.";
    if (e.status >= 500) return "Máy chủ đang bận hoặc vừa khởi động. Hãy thử lại sau ít giây.";
    return "Lỗi: " + e.message;
  }
  return "Mạng yếu hoặc mất kết nối. Ảnh vẫn được giữ, hãy bấm gửi lại.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendBatch(ctx, batch) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = new FormData();
      batch.forEach((it, i) => fd.append("files", it.blob, `${it.pose}_${i}.jpg`));
      fd.append("poses", batch.map((it) => it.pose).join(","));
      fd.append("qualities", batch.map((it) => it.quality.toFixed(4)).join(","));
      fd.append("token", ctx.token);
      return await req("/api/members/" + encodeURIComponent(ctx.member_id) + "/images", { method: "POST", body: fd });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403) && !refreshed) { ctx.token = await ctx.refresh(); refreshed = true; continue; }
      const retryable = !(e instanceof ApiError) || e.status >= 500;
      if (!retryable || attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt); // 1s, 2s, 4s, 8s (gửi lại an toàn vì server chống trùng bằng sha256)
    }
  }
}

/** Gửi lần lượt từng lô; lô lỗi không làm mất ảnh. Trả về {totals, failed, error}. */
export async function uploadAll(ctx, items, onProgress, batchSize = 5) {
  const totals = { saved: 0, duplicates: 0, rejected: 0 };
  const failed = []; let done = 0, error = null;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      const r = await sendBatch(ctx, batch);
      totals.saved += r.saved; totals.duplicates += r.duplicates; totals.rejected += r.rejected.length;
      const rej = new Set(r.rejected.map((x) => x.index));
      batch.forEach((it, k) => { it.uploaded = !rej.has(k); it.rejected = rej.has(k); });
      done += batch.length;
    } catch (e) {
      failed.push(...batch); error = e;
      if (e instanceof ApiError && e.status < 500 && e.status !== 401) { failed.push(...items.slice(i + batchSize)); break; }
    }
    onProgress({ done, total: items.length, failed: failed.length });
  }
  return { totals, failed, error };
}
