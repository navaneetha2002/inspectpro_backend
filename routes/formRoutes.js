const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db/db');

function parseAnswers(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) &&
               allowed.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only image files allowed'));
  },
});

// GET /api/form/categories
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/form/:slug?group=1
router.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    //const group    = parseInt(req.query.group) || 1;

    const { rows: cats } = await pool.query('SELECT * FROM categories WHERE slug=$1', [slug]);
    if (!cats.length) return res.status(404).json({ error: 'Category not found' });

    const { rows: allQuestions } = await pool.query(
      'SELECT * FROM questions WHERE category_id=$1 ORDER BY order_index',
      [cats[0].id]
    );

    //const maxGroup     = allQuestions.reduce((m, q) => Math.max(m, q.group_index), 1);
    //const groupQuestions = allQuestions.filter(q => q.group_index === group);

    res.json({
      category:    cats[0],
      questions:   allQuestions,
    });
  } catch (err) { next(err); }
});

// POST /api/form/:slug/submit
router.post('/:slug/submit', upload.array('images', 10), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { slug }  = req.params;
    const answers   = parseAnswers(req.body.answers);
    const location_id   = req.body.location_id || null;

    const { rows: cats } = await pool.query('SELECT * FROM categories WHERE slug=$1', [slug]);
    if (!cats.length) return res.status(404).json({ error: 'Category not found' });

    await client.query('BEGIN');

    const { rows: sub } = await client.query(
      `INSERT INTO form_submissions (category_id, location_id, answers)
       VALUES ($1, $2, $3) RETURNING id, submission_uuid`,
      [cats[0].id, location_id, JSON.stringify(answers)]
    );
    const submissionId   = sub[0].id;
    const submissionUuid = sub[0].submission_uuid;

    if (req.files && req.files.length) {
      for (const file of req.files) {
        const imageBuffer = fs.readFileSync(file.path);
        await client.query(
          `INSERT INTO submission_images
             (submission_id, filename, original_name, mimetype, size, image_data)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [submissionId, file.filename, file.originalname, file.mimetype, file.size, imageBuffer]
        );
        fs.unlinkSync(file.path); // clean up temp file
      }
    }

    await client.query('COMMIT');
    res.json({ submissionUuid });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/form/image/:id
router.get('/image/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT image_data, mimetype, original_name FROM submission_images WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].image_data)
      return res.status(404).send('Image not found');
    res.setHeader('Content-Type', rows[0].mimetype || 'image/jpeg');
    res.send(rows[0].image_data);
  } catch (err) { next(err); }
});

module.exports = router;