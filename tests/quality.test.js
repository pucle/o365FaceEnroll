const Q = require('../static/js/quality.js'); let bad = 0, n = 0;
function t(name, ok, info) { n++; if (!ok) { bad++; console.log('FAIL', name, info || ''); } }
// laplacian: ảnh phẳng = 0, ảnh nhiều chi tiết > ảnh mờ
const flat = new Uint8Array(64 * 64).fill(100), noisy = new Uint8Array(64 * 64).map((_, i) => (i * 7919) % 256);
t('flat=0', Q.laplacianVar(flat, 64, 64) === 0); t('noisy>flat', Q.laplacianVar(noisy, 64, 64) > 100);
// calibrate: dấu bị đảo (raw yaw âm khi quay trái) -> yawSign=-1
const fr = (phase, yaw, pitch) => ({ phase, yaw, pitch, roll: 0 });
let frames = []; for (let i = 0; i < 6; i++) { frames.push(fr('front', 3, 5), fr('left', -42, 5), fr('right', 48, 5), fr('up', 3, -40), fr('down', 3, 50)); }
const cal = Q.calibrate(frames);
t('yawSign flips', cal.yawSign === -1, JSON.stringify(cal)); t('pitchSign flips', cal.pitchSign === -1);
const a = Q.adjust(fr('left', -42, 5), cal); t('left -> +45', Math.abs(a.yaw - 45) < 1.5, a.yaw);
const a2 = Q.adjust(fr('up', 3, -40), cal); t('up -> +45', Math.abs(a2.pitch - 45) < 1.5, a2.pitch);
// score: mặt đúng góc điểm cao; sai tư thế bị loại
const base = { faceRatio: 0.4, inFrame: true, nFaces: 1, sharp: 120, mean: 125, std: 55 };
const good = Q.score(Object.assign({ phase: 'left', yaw: -45, pitch: 5, roll: 0 }, base), cal);
const wrong = Q.score(Object.assign({ phase: 'left', yaw: 3, pitch: 5, roll: 0 }, base), cal);
t('good ok', good.ok && good.score > 0.85, JSON.stringify(good)); t('wrong pose rejected', !wrong.ok && wrong.reasons.includes('sai tư thế'));
t('blur rejected', !Q.score(Object.assign({ phase: 'front', yaw: 3, pitch: 5 }, base, { sharp: 5 }), cal).ok);
t('dark rejected', !Q.score(Object.assign({ phase: 'front' }, base, { mean: 20 }), null).ok);
t('small rejected', !Q.score(Object.assign({ phase: 'front' }, base, { faceRatio: 0.1 }), null).ok);
t('2 faces rejected', !Q.score(Object.assign({ phase: 'front' }, base, { nFaces: 2 }), null).ok);
t('cut rejected', !Q.score(Object.assign({ phase: 'front' }, base, { inFrame: false }), null).ok);
// quotas tổng = max
const ph = ['front', 'left', 'right', 'up', 'down'], q = Q.quotas(ph, 30);
t('quota sum', Object.values(q).reduce((x, y) => x + y, 0) === 30, JSON.stringify(q)); t('front >= others', q.front >= q.left);
// select: loại khung gần giống, tôn trọng max, báo thiếu
let cands = [], k = 0;
ph.forEach(p => { for (let i = 0; i < 20; i++) cands.push({ phase: p, ok: true, score: 0.5 + (i % 7) / 20, sig: new Array(64).fill(((i * 37 + k++ * 13) % 200)) }); });
const sel = Q.select(cands, ph, { max: 30, min: 20 });
t('select <= max', sel.chosen.length <= 30 && sel.chosen.length >= 20, sel.chosen.length); t('no short', sel.short.length === 0, sel.short);
const dup = []; for (let i = 0; i < 30; i++) dup.push({ phase: 'front', ok: true, score: 0.9, sig: new Array(64).fill(100) });
const s2 = Q.select(dup, ph, { max: 30, min: 20 }); t('dedupe identical -> 1', s2.chosen.length === 1, s2.chosen.length); t('reports short phases', s2.short.length === 5);
// giữ yên: 22 khung/tư thế chỉ khác nhau do nhiễu camera (±1.5) + 1/3 khung lỗi nhẹ -> vẫn phải chọn >= 20 và đủ mọi tư thế
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const still = [];
ph.forEach((p, pi) => { for (let i = 0; i < 22; i++) { const soft = i % 3 === 0, f = { phase: p, ok: !soft, score: 0.6 + rnd() * 0.2, rank: 0, sig: new Array(64).fill(0).map(() => pi * 40 + 100 + (rnd() - 0.5) * 3) };
  f.rank = soft ? f.score * 0.5 : f.score; f.soft = soft; still.push(f); } });
const s3 = Q.select(still, ph, { max: 30, min: 20 }); t('still frames still give >=20', s3.chosen.length >= 20, s3.chosen.length); t('still: no short phase', s3.short.length === 0, s3.short);
console.log(n - bad + '/' + n + ' test đạt'); process.exit(bad ? 1 : 0);
