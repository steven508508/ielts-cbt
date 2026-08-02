'use strict';
/* 上傳與下載的安全處理。
 *
 * 原本的寫法是 `const ext = req.file.originalname.match(/\.\w+$/)`，
 * 也就是**副檔名由上傳的人決定**。學生只要把錄音那個欄位換成一個叫
 * evil.html 的檔案，就會在 uploads/speaking/<id>/p1_q0.html 落地；
 * 而 /uploads 是 express.static 直接掛上去的，不需要任何身分就能拿，
 * 回應的 Content-Type 還是 text/html。
 *
 * 也就是說：任何學生都能在**考試站的同源底下**放一個會執行的網頁。
 * 把連結傳給老師（「老師我這題錄音怪怪的」），老師點開，那段 script
 * 就能讀 localStorage 裡的 token —— 直接拿到老師或管理員的完整權限。
 *
 * 這裡的規則：
 *   · 副檔名一律由伺服器依 MIME 決定，白名單以外一概拒絕
 *   · SVG 不收（SVG 裡可以寫 script）
 *   · 送出去的時候明確指定 Content-Type，絕不讓瀏覽器自己猜
 */

const AUDIO = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/wave': '.wav', 'video/webm': '.webm', 'video/mp4': '.mp4',
};
const IMAGE = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
};

/** 副檔名 → 送出時要宣告的 Content-Type。名單以外一律當成下載檔。 */
const SERVE_TYPE = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

/**
 * 依 MIME 決定副檔名。認不出來就退回看原檔名，但一樣要在白名單裡。
 * 兩邊都不合就回 null（呼叫端要拒收）。
 */
function safeExt(mimetype, originalname = '', kind = 'audio') {
  const table = kind === 'image' ? IMAGE : AUDIO;
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (table[mime]) return table[mime];
  const m = String(originalname).toLowerCase().match(/\.[a-z0-9]+$/);
  if (m && Object.values(table).includes(m[0])) return m[0];
  return null;
}

/** multer 的 fileFilter：白名單以外直接擋在寫入之前 */
const fileFilter = (kind) => (req, file, cb) => {
  if (safeExt(file.mimetype, file.originalname, kind)) return cb(null, true);
  const e = new Error(kind === 'image' ? '只接受 PNG / JPG / GIF / WebP 圖片' : '只接受常見的音訊格式');
  e.status = 400;
  cb(e);
};

/** 檔名清乾淨：不留路徑、不留奇怪字元 */
function safeBase(name, max = 60) {
  return String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w一-鿿-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max) || 'file';
}

/** 送檔案出去時要設的標頭。認不得的副檔名一律當附件，不讓它在頁面上跑。 */
function serveHeaders(ext) {
  const type = SERVE_TYPE[String(ext || '').toLowerCase()];
  return type
    ? { 'Content-Type': type, 'Content-Disposition': 'inline' }
    : { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' };
}

module.exports = { safeExt, fileFilter, safeBase, serveHeaders, AUDIO, IMAGE, SERVE_TYPE };
