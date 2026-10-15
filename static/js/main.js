/* Luồng đăng ký: thông tin -> chuẩn bị -> quay theo kịch bản (HUD theo thời gian, quay liên tục) -> chọn ảnh tốt -> xem lại -> gửi. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CFG = { max_side: 512, jpeg_quality: 0.85, poses: ['front', 'left', 'right', 'up', 'down'], min_frames: 20, max_frames: 30, require_code: false };
  var LABEL = { front: ['Nhìn thẳng', 'Nhìn vào camera, giữ yên'], left: ['Quay sang TRÁI', 'Từ từ quay đầu sang trái ~45°, mắt vẫn liếc về camera'],
    right: ['Quay sang PHẢI', 'Từ từ quay đầu sang phải ~45°'], up: ['Ngẩng lên', 'Hơi ngẩng cằm lên'], down: ['Cúi xuống', 'Hơi cúi đầu xuống, vẫn thấy mắt'],
    tilt_left: ['Nghiêng đầu trái', 'Nghiêng đầu sang vai trái'], tilt_right: ['Nghiêng đầu phải', 'Nghiêng đầu sang vai phải'] };
  var SHORT = { front: 'Thẳng', left: 'Trái', right: 'Phải', up: 'Ngẩng', down: 'Cúi', tilt_left: 'Nghiêng T', tilt_right: 'Nghiêng P' };
  var MOVE_MS = 1600, HOLD_MS = { front: 4500, left: 4500, right: 4500, up: 4000, down: 4000, tilt_left: 3000, tilt_right: 3000 }, TICK = 110;
  var S = { member: null, token: null, cands: [], chosen: [], running: false, cancel: false, basic: false, existing: 0 };

  function show(id) { ['s-form', 's-guide', 's-cam', 's-review', 's-done'].forEach(function (x) { $(x).hidden = x !== id; }); window.scrollTo(0, 0); }
  function say(id, text, cls) { var e = $(id); e.textContent = text || ''; e.className = 'msg' + (cls ? ' ' + cls : ''); }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) { CFG = c; $('lCode').hidden = !c.require_code; }).catch(function () {});
  // tải MediaPipe nền ngay khi mở trang để lúc quay đã sẵn sàng
  var poseReady = Pose.init();

  $('bStart').onclick = async function () {
    var id = $('fId').value.trim(), name = $('fName').value.trim();
    if (!id || !name) return say('msgForm', 'Hãy nhập mã thành viên và họ tên.', 'err');
    $('bStart').disabled = true; say('msgForm', 'Đang kiểm tra…');
    try {
      var r = await Upload.register({ member_id: id, full_name: name, group: $('fGroup').value.trim() || null, invite_code: $('fCode').value.trim() || null });
      S.member = r.member_id; S.token = r.upload_token; S.existing = r.existing_images;
      say('msgForm', '');
      say('msgPose', r.existing_images ? 'Bạn đã có ' + r.existing_images + ' ảnh. Lần này ảnh mới sẽ được thêm vào.' : '', 'ok');
      show('s-guide');
    } catch (e) { say('msgForm', e.message + (e.status === undefined ? ' (không kết nối được máy chủ — nếu dùng Render miễn phí, đợi ~1 phút rồi thử lại)' : ''), 'err'); }
    $('bStart').disabled = false;
  };
  $('bBack').onclick = function () { show('s-form'); };
  $('bCancel').onclick = function () { S.cancel = true; Cam.stop(); show('s-guide'); };
  $('bAgain').onclick = function () { S.cands = []; S.chosen = []; show('s-form'); };
  $('bRedo').onclick = function () { S.cands = []; S.chosen = []; startCamera(); };

  async function startCamera() {
    show('s-cam'); say('msgCam', ''); $('bGo').disabled = true; setHud('Đang bật camera…', '');
    renderSteps(-1, []);
    try { await Cam.start($('vid'), 'user'); } catch (e) {
      say('msgCam', 'Không bật được camera: ' + (e.name === 'NotAllowedError' ? 'bạn chưa cho phép truy cập camera. Bấm biểu tượng ổ khoá trên thanh địa chỉ → cho phép Camera.' : e.message), 'err');
      setHud('Camera chưa sẵn sàng', ''); return;
    }
    setHud('Đang tải bộ đo góc mặt…', 'Chờ vài giây');
    var ok = await poseReady; S.basic = !ok;
    say('msgCam', ok ? '' : 'Không tải được bộ đo góc mặt (mạng chặn?). Vẫn quay được ở chế độ cơ bản: chỉ kiểm tra độ nét/sáng, không kiểm tra góc quay.', ok ? '' : 'warn');
    setHud('Sẵn sàng', 'Đặt mặt trong khung rồi bấm “Bắt đầu quay”'); $('bGo').disabled = false;
  }
  $('bCam').onclick = startCamera;
  $('bGo').onclick = run;

  function setHud(a, b) { $('hudMain').textContent = a; $('hudSub').textContent = b || ''; }
  function renderSteps(cur, done) {
    $('steps').innerHTML = CFG.poses.map(function (p, i) { return '<span class="' + (done.indexOf(p) >= 0 ? 'done' : i === cur ? 'on' : '') + '">' + SHORT[p] + '</span>'; }).join('');
  }

  async function run() {
    if (S.running) return; S.running = true; S.cancel = false; S.cands = []; $('bGo').disabled = true;
    for (var c = 3; c > 0 && !S.cancel; c--) { setHud(String(c), 'Chuẩn bị'); await sleep(900); }
    var done = [], t0 = performance.now();
    for (var pi = 0; pi < CFG.poses.length && !S.cancel; pi++) {
      var ph = CFG.poses[pi], lab = LABEL[ph] || [ph, ''], hold = HOLD_MS[ph] || 3500, total = MOVE_MS + hold, ps = performance.now();
      renderSteps(pi, done); setHud(lab[0], lab[1]); $('ring').className = 'ring move';
      var lastSeen = performance.now();
      while (!S.cancel) {
        var el = performance.now() - ps; if (el >= total) break;
        $('bar').firstElementChild.style.width = (el / total * 100) + '%';
        var capture = el >= MOVE_MS; $('ring').className = 'ring ' + (capture ? 'hold' : 'move');
        if (capture) $('hudSub').textContent = lab[1] + ' — giữ yên';
        var info = Pose.ready() ? Pose.detect($('vid'), Math.round(performance.now())) : null;
        if (info && info.nFaces !== 1) $('liveInfo').textContent = info.nFaces ? 'Chỉ một người trong khung hình.' : 'Không thấy mặt — đưa mặt vào khung.';
        else $('liveInfo').textContent = '';
        if (capture) await grab(ph, info);
        var wait = TICK - ((performance.now() - ps) % TICK); await sleep(Math.max(30, wait));
      }
      done.push(ph);
    }
    S.running = false; $('bar').firstElementChild.style.width = '0'; $('ring').className = 'ring';
    if (S.cancel) return;
    renderSteps(-1, done); setHud('Đang chọn ảnh đẹp…', ''); Cam.stop(); await sleep(50);
    finish();
  }

  async function grab(phase, info) {
    var a = Cam.analyze(info && info.bbox ? info.bbox : null);
    var f = { phase: phase, nFaces: info ? info.nFaces : 1, faceRatio: info && info.faceRatio != null ? info.faceRatio : 0.4, inFrame: info && info.inFrame != null ? info.inFrame : true,
      sharp: a.sharp, mean: a.mean, std: a.std, sig: a.sig, yaw: info ? info.yaw : null, pitch: info ? info.pitch : null, roll: info ? info.roll : null };
    if (f.nFaces === 1) f.blob = await Cam.cropBlob(a.crop, CFG.max_side || 512, CFG.jpeg_quality || 0.85);     // chỉ giữ ảnh khi có đúng 1 mặt (bộ nhớ)
    S.cands.push(f);
  }

  function finish() {
    var cal = S.basic ? null : Quality.calibrate(S.cands);
    if (cal && (cal.yawSep < 15 || cal.pitchSep < 8)) cal = (cal.yawSep < 15 && cal.pitchSep < 8) ? null : cal;   // quá ít chuyển động: bỏ lọc góc
    S.cands.forEach(function (c) { var r = Quality.score(c, cal); c.score = r.score; c.ok = r.ok && !!c.blob; c.rank = c.blob ? r.rank : -1; c.reasons = r.reasons; });
    var why = {}, nob = 0; S.cands.forEach(function (c) { if (!c.blob) nob++; (c.reasons || []).forEach(function (r) { why[r] = (why[r] || 0) + 1; }); });
    S.why = Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).slice(0, 4).map(function (k) { return k + ' ' + why[k]; }).join(', ') + (nob ? (', không thấy mặt/nhiều mặt ' + nob) : '');
    var sel = Quality.select(S.cands, CFG.poses, { min: CFG.min_frames, max: CFG.max_frames });
    S.chosen = sel.chosen; S.short = sel.short;
    renderReview(sel, cal);
    show('s-review');
  }

  function renderReview(sel, cal) {
    var n = S.chosen.length;
    var info = 'Hệ thống đã quay ' + S.cands.length + ' khung và chọn ' + n + ' ảnh tốt nhất. Bỏ ảnh nào bạn không muốn gửi bằng nút ✕.';
    if (!cal) info += ' (Không lọc theo góc mặt.)';
    if (n < CFG.min_frames && S.why) info += ' Lỗi hay gặp: ' + S.why + '.';
    $('reviewInfo').textContent = info;
    if (n < CFG.min_frames || sel.short.length) {
      say('msgRev', 'Chưa đủ ảnh tốt' + (sel.short.length ? ' cho: ' + sel.short.map(function (p) { return SHORT[p]; }).join(', ') : '') + '. Hãy quay lại từ đầu ở nơi sáng hơn, giữ mặt trong khung. Bạn vẫn có thể gửi số ảnh hiện có.', 'warn');
    } else say('msgRev', '');
    var g = $('grid'); g.innerHTML = '';
    S.chosen.forEach(function (c, i) {
      var fig = document.createElement('figure'), im = document.createElement('img');
      c.url = c.url || URL.createObjectURL(c.blob); im.src = c.url; im.alt = c.phase;
      var cap = document.createElement('figcaption'), sp = document.createElement('span'), bt = document.createElement('button');
      sp.textContent = SHORT[c.phase]; bt.textContent = '✕'; bt.setAttribute('aria-label', 'Bỏ ảnh này');
      bt.onclick = function () { S.chosen = S.chosen.filter(function (x) { return x !== c; }); URL.revokeObjectURL(c.url); renderReview(sel, cal); };
      cap.appendChild(sp); cap.appendChild(bt); fig.appendChild(im); fig.appendChild(cap); g.appendChild(fig);
    });
    $('bSend').disabled = !n;
  }

  $('bSend').onclick = async function () {
    if (!S.chosen.length) return;
    $('bSend').disabled = true; $('bRedo').disabled = true; $('prog').hidden = false; say('msgRev', 'Đang gửi…');
    var bar = $('prog').firstElementChild;
    try {
      var r = await Upload.sendAll(S.member, S.token, S.chosen.map(function (c) { return { blob: c.blob, pose: c.phase, quality: c.score }; }), function (d, t) { bar.style.width = (d / t * 100) + '%'; });
      S.chosen.forEach(function (c) { if (c.url) URL.revokeObjectURL(c.url); }); S.cands = []; S.chosen = [];
      $('doneInfo').textContent = 'Đã lưu ' + r.saved + ' ảnh' + (r.duplicates ? ' (' + r.duplicates + ' ảnh trùng bị bỏ qua)' : '') + '. Tổng số ảnh của bạn: ' + r.total + '.' +
        (r.rejected.length ? ' ' + r.rejected.length + ' ảnh bị từ chối.' : '');
      show('s-done');
    } catch (e) {
      say('msgRev', 'Gửi chưa xong' + (e.sent ? ' (đã gửi ' + e.sent + ' ảnh)' : '') + ': ' + e.message + '. Bấm “Gửi ảnh” để thử lại — ảnh đã gửi sẽ không bị trùng.', 'err');
      $('bSend').disabled = false;
    }
    $('bRedo').disabled = false;
  };
})();
