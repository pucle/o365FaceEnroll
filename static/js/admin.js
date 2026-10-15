(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var BASE = ((document.querySelector('meta[name="api-base"]') || {}).content || '').replace(/\/$/, '');
  var tok = ''; try { tok = sessionStorage.getItem('adm') || ''; } catch (e) {}
  var cur = null, timer = null, stats = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mb(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }
  function toast(t) { var e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(function () { e.classList.remove('on'); }, 2600); }
  function msg(id, t, c) { var e = $(id); e.textContent = t || ''; e.className = 'msg' + (c ? ' ' + c : ''); }
  async function api(url, opt) {
    opt = opt || {}; opt.headers = Object.assign({ Authorization: 'Bearer ' + tok.trim() }, opt.headers || {});
    var r;
    try { r = await fetch(BASE + url, opt); } catch (e) { throw new Error('Không kết nối được máy chủ (Render free có thể đang khởi động, đợi ~1 phút).'); }
    if (r.status === 401 || r.status === 403) throw new Error('Mã quản trị không đúng.');
    if (!r.ok) { var j = null; try { j = await r.json(); } catch (e) {} throw new Error((j && j.detail) || 'Lỗi ' + r.status); }
    return r;
  }

  async function loadStats() {
    stats = await (await api('/api/admin/stats')).json();
    var quota = stats.backend === 'db' ? 512e6 : stats.free_bytes, pct = Math.min(100, stats.bytes / quota * 100), cls = pct > 90 ? 'bad' : pct > 70 ? 'warn' : '';
    $('stats').innerHTML =
      '<div class="stat"><span>Thành viên</span><b>' + stats.members + '</b></div>' +
      '<div class="stat"><span>Tổng số ảnh</span><b>' + stats.images + '</b></div>' +
      '<div class="stat"><span>Chưa xuất</span><b>' + stats.pending + '</b></div>' +
      '<div class="stat"><span>Dung lượng ' + (stats.backend === 'db' ? '(Neon)' : '(R2)') + '</span><b>' + mb(stats.bytes) + '</b><div class="meter ' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>';
    $('quota').textContent = pct.toFixed(1) + '% của ~' + mb(quota) + ' (hạn mức gói miễn phí tham khảo)';
  }
  async function loadRows() {
    var q = encodeURIComponent($('q').value.trim()), st = $('st').value;
    var ms = await (await api('/api/admin/members?limit=200&status=' + st + '&q=' + q)).json();
    var min = stats ? stats.min_frames : 20;
    $('rows').innerHTML = ms.items.map(function (m) {
      var low = m.image_count < min;
      return '<tr><td><div class="who"><span class="av">' + esc((m.full_name || '?').trim().split(/\s+/).pop().charAt(0).toUpperCase()) + '</span><div><b>' + esc(m.full_name) + '</b><div class="muted small">' + esc(m.member_id) + '</div></div></div></td>' +
        '<td>' + esc(m.group || '—') + '</td><td>' + m.image_count + (low ? ' <span class="pill warn">thiếu</span>' : '') + '</td>' +
        '<td><span class="pill ' + (m.status === 'exported' ? 'ok' : '') + '">' + (m.status === 'exported' ? 'đã xuất' : 'chưa xuất') + '</span></td>' +
        '<td><button class="btn small" data-id="' + esc(m.member_id) + '">Xem ảnh</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">Chưa có thành viên phù hợp.</td></tr>';
    $('rows').querySelectorAll('button').forEach(function (b) { b.onclick = function () { detail(b.dataset.id); }; });
  }
  async function refresh() { await loadStats(); await loadRows(); }

  async function detail(id) {
    var m = await (await api('/api/admin/members/' + encodeURIComponent(id))).json(); cur = id;
    $('detail').hidden = false; $('dTitle').textContent = m.full_name + ' · ' + m.member_id;
    $('dMeta').textContent = m.images.length + ' ảnh' + (m.group ? ' · ' + m.group : '');
    $('thumbs').innerHTML = m.images.map(function (im) {
      var u = im.url, src = u.charAt(0) === '/' ? 'data-src="' + esc(BASE + u) + '"' : 'src="' + esc(u) + '"';
      return '<figure><img loading="lazy" alt="" ' + src + '><button data-img="' + im.id + '" title="Xoá ảnh">×</button><small>' + esc(im.pose) + (im.quality != null ? ' · ' + Number(im.quality).toFixed(2) : '') + '</small></figure>';
    }).join('');
    $('thumbs').querySelectorAll('img[data-src]').forEach(async function (img) {      // ảnh cần xác thực: tải kèm header rồi gắn blob
      try { var b = await (await api(img.dataset.src.slice(BASE.length))).blob(); img.src = URL.createObjectURL(b); } catch (e) {} });
    $('thumbs').querySelectorAll('button[data-img]').forEach(function (b) { b.onclick = async function () {
      if (!confirm('Xoá ảnh này?')) return; try { await api('/api/admin/images/' + b.dataset.img, { method: 'DELETE' }); toast('Đã xoá ảnh'); detail(id); refresh(); } catch (e) { toast(e.message); } }; });
  }
  $('dClose').onclick = function () { $('detail').hidden = true; };
  $('detail').onclick = function (e) { if (e.target === $('detail')) $('detail').hidden = true; };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('detail').hidden = true; });
  $('bDelAll').onclick = async function () { if (cur && confirm('Xoá TOÀN BỘ ảnh của ' + cur + '? (giữ thành viên để quét lại)')) { try { await api('/api/admin/members/' + encodeURIComponent(cur) + '/clear', { method: 'POST' }); $('detail').hidden = true; toast('Đã xoá ảnh'); refresh(); } catch (e) { toast(e.message); } } };
  $('bDelMem').onclick = async function () { if (cur && confirm('Xoá thành viên ' + cur + ' cùng mọi ảnh?')) { try { await api('/api/admin/members/' + encodeURIComponent(cur), { method: 'DELETE' }); $('detail').hidden = true; toast('Đã xoá thành viên'); refresh(); } catch (e) { toast(e.message); } } };

  async function download(url, name) {
    msg('msgDl', 'Đang tải… file lớn có thể mất vài phút.');
    try { var r = await api(url), b = await r.blob(), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);
      msg('msgDl', 'Đã tải ' + name + ' (' + mb(b.size) + ').', 'ok');
    } catch (e) { msg('msgDl', e.message, 'err'); }
  }
  $('bZip').onclick = function () { download('/api/admin/export.zip', 'dataset.zip'); };
  $('bZipNew').onclick = function () { download('/api/admin/export.zip?status=pending', 'dataset_new.zip'); };
  $('bMan').onclick = function () { download('/api/admin/manifest', 'manifest.json'); };
  $('bCsv').onclick = async function () {
    try { var j = await (await api('/api/admin/manifest')).json();
      var rows = (j.members || []).map(function (m) { return { member_id: m.member_id, full_name: m.full_name, group: m.group, image_count: m.image_count, status: m.status, collected_at: m.collected_at }; });
      var cols = rows.length ? Object.keys(rows[0]) : [], q = function (v) { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      var csv = [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); })).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = 'manifest.csv'; a.click(); } catch (e) { msg('msgDl', e.message, 'err'); }
  };
  $('bMark').onclick = async function () {
    try { var ms = await (await api('/api/admin/members?status=pending&limit=200')).json();
      if (!ms.items.length) return msg('msgDl', 'Không có thành viên chưa xuất.');
      if (!confirm('Đánh dấu ' + ms.items.length + ' thành viên là ĐÃ XUẤT?')) return;
      await api('/api/admin/mark-exported', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_ids: ms.items.map(function (m) { return m.member_id; }) }) });
      msg('msgDl', 'Đã đánh dấu.', 'ok'); refresh(); } catch (e) { msg('msgDl', e.message, 'err'); }
  };
  $('q').oninput = function () { clearTimeout(timer); timer = setTimeout(function () { loadRows().catch(function (e) { toast(e.message); }); }, 300); };
  $('st').onchange = function () { loadRows().catch(function (e) { toast(e.message); }); };

  async function enter() {
    tok = $('tok').value || tok; $('bLogin').disabled = true; msg('msgLogin', 'Đang đăng nhập…');
    try { await refresh(); try { sessionStorage.setItem('adm', tok); } catch (e) {} $('login').hidden = true; $('app').hidden = false; $('bLogout').hidden = false; msg('msgLogin', ''); }
    catch (e) { msg('msgLogin', e.message, 'err'); }
    $('bLogin').disabled = false;
  }
  $('bLogout').onclick = function () { try { sessionStorage.removeItem('adm'); } catch (e) {} location.reload(); };
  $('bLogin').onclick = enter; $('tok').onkeydown = function (e) { if (e.key === 'Enter') enter(); };
  if (tok) enter();
})();
