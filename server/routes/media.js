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

function kindOf(mime, name) {
  if (/^audio\//.test(mime) || /\.(mp3|wav|m4a|ogg|aac|webm)$/i.test(name)) return 'audio';
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
  return 'other';
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const kind = kindOf(file.mimetype, file.originalname);
    const dir = path.join(config.UPLOAD_DIR, kind);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^\w一-龥.-]+/g, '_').slice(0, 60);
    cb(null, `${Date.now().toString(36)}_${base}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

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
