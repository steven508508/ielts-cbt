'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const uploadLimit = rateLimit({ key: 'upload', by: 'user', windowMs: 60_000, max: 10, message: '上傳太頻繁' });

const { safeExt, safeBase } = require('../lib/uploadSafety');

/* 'other' 這一類拿掉了。以前副檔名直接取自使用者送的檔名，而 kindOf
   認不出來就丟進 uploads/other/ —— 上傳一個 .html 就會落地成一個同源、
   免驗證、Content-Type 是 text/html 的網頁。SVG 也不再收，SVG 裡可以寫
   script，當成圖片載入時照樣會跑。 */
function kindOf(mime, name) {
  if (safeExt(mime, name, 'audio')) return 'audio';
  if (safeExt(mime, name, 'image')) return 'image';
  return null;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const kind = kindOf(file.mimetype, file.originalname);
    const dir = path.join(config.UPLOAD_DIR, kind);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const kind = kindOf(file.mimetype, file.originalname);
    // 副檔名由伺服器依 MIME 決定，不是由上傳的人決定
    const ext = safeExt(file.mimetype, file.originalname, kind);
    cb(null, `${Date.now().toString(36)}_${safeBase(file.originalname)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (kindOf(file.mimetype, file.originalname)) return cb(null, true);
    const e = new Error('只接受音訊（mp3/wav/m4a/ogg/webm）與圖片（png/jpg/gif/webp）');
    e.status = 400;
    cb(e);
  },
});

router.use(requireAuth);

router.get('/', requireStaff, async (req, res) => {
  const kind = req.query.kind;
  const rows = kind
    ? await db.query('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC', [kind])
    : await db.query('SELECT * FROM media ORDER BY created_at DESC');
  res.json({
    media: rows.map((r) => ({
      id: r.id, url: `/uploads/${r.kind}/${r.filename}`,
      name: r.original_name, kind: r.kind, size: r.size, label: r.label, createdAt: r.created_at,
    })),
  });
});

router.post('/', requireStaff, uploadLimit, upload.array('files', 20), async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    const kind = kindOf(f.mimetype, f.originalname);
    const id = await db.insert(
      'INSERT INTO media (filename, original_name, kind, mime, size, label, folder, tags, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [f.filename, f.originalname, kind, f.mimetype, f.size,
       req.body.label || null, req.body.folder || null, req.body.tags || null, req.user.id]
    );
    out.push({ id, url: `/uploads/${kind}/${f.filename}`, name: f.originalname, kind, size: f.size });
  }
  res.json({ media: out });
});

router.delete('/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT * FROM media WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到檔案' });
  const p = path.join(config.UPLOAD_DIR, row.kind, row.filename);
  fs.promises.unlink(p).catch(() => {});
  await db.exec('DELETE FROM media WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
module.exports.upload = upload;
