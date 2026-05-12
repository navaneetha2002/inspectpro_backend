const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db/db');
const { authenticateToken, optionalAuth, requireAuth } = require('../middleware/auth');

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
router.get('/categories', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/form/my-submissions?location=<slug>
router.get('/my-submissions', authenticateToken, optionalAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { location } = req.query;

    let query, params;
    if (location) {
      query = `
        SELECT fs.submission_uuid, fs.submitted_at, c.name AS category_name, c.slug
        FROM form_submissions fs
        JOIN categories c ON c.id = fs.category_id
        JOIN locations  l ON l.id = fs.location_id
        WHERE fs.user_id = $1 AND l.slug = $2
        ORDER BY fs.submitted_at DESC
      `;
      params = [userId, location];
    } else {
      query = `
        SELECT fs.submission_uuid, fs.submitted_at, c.name AS category_name, c.slug
        FROM form_submissions fs
        JOIN categories c ON c.id = fs.category_id
        WHERE fs.user_id = $1
        ORDER BY fs.submitted_at DESC
      `;
      params = [userId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/form/image/:id
const axios = require('axios');
router.get('/image/:id', authenticateToken, async (req, res, next) => {
  try {
    // Proxy the image request to the SAP frontend URL
    const sapUrl = `https://inspectpro-frontend.cfapps.eu10-004.hana.ondemand.com/api/form/image/${req.params.id}`;
    const sapResponse = await axios.get(sapUrl, { responseType: 'arraybuffer' });
    res.setHeader('Content-Type', sapResponse.headers['content-type'] || 'image/jpeg');
    res.send(sapResponse.data);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).send('Image not found');
    }
    next(err);
  }
});

// GET /api/form/:slug?group=1
router.get('/:slug', authenticateToken, async (req, res, next) => {
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
router.post('/:slug/submit', optionalAuth, upload.array('images', 10), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { slug }      = req.params;
    const answers       = parseAnswers(req.body.answers);
    const locationSlug  = req.body.locationSlug || null;
    const userId        = req.user ? req.user.id : null;

    let location_id = null;
    if (locationSlug) {
      const { rows: locs } = await pool.query(
        'SELECT id FROM locations WHERE slug=$1',
        [locationSlug]
      );
      if (locs.length) location_id = locs[0].id;
    }

    const { rows: cats } = await pool.query('SELECT * FROM categories WHERE slug=$1', [slug]);
    if (!cats.length) return res.status(404).json({ error: 'Category not found' });

    await client.query('BEGIN');

    const { rows: sub } = await client.query(
      `INSERT INTO form_submissions (category_id, location_id, answers, user_id)
       VALUES ($1, $2, $3, $4) RETURNING id, submission_uuid`,
      [cats[0].id, location_id, JSON.stringify(answers), userId]
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

// GET /api/form/:slug/my-submission?schedule_id=X
// If schedule_id is given and the schedule already has a linked submission, return it as read-only.
// Returns 404 when no submission is linked (caller should open the form).
router.get('/:slug/my-submission', authenticateToken, optionalAuth, async (req, res, next) => {
  try {
    const { schedule_id } = req.query;
    if (!schedule_id) return res.status(404).json({ error: 'No submission found' });

    const { rows: schedRows } = await pool.query(
      'SELECT submission_id FROM inspection_schedules WHERE id = $1',
      [schedule_id]
    );
    if (!schedRows.length) return res.status(404).json({ error: 'Schedule not found' });

    const { submission_id } = schedRows[0];
    if (!submission_id) return res.status(404).json({ error: 'No submission linked to this schedule' });

    const { rows: subRows } = await pool.query(
      `SELECT fs.*, c.name AS category_name, l.name AS location_name
       FROM form_submissions fs
       LEFT JOIN categories c ON c.id = fs.category_id
       LEFT JOIN locations  l ON l.id = fs.location_id
       WHERE fs.id = $1`,
      [submission_id]
    );
    if (!subRows.length) return res.status(404).json({ error: 'Submission not found' });

    const submission = subRows[0];

    const { rows: images } = await pool.query(
      'SELECT id, original_name, mimetype, uploaded_at FROM submission_images WHERE submission_id = $1',
      [submission.id]
    );

    const { rows: questions } = await pool.query(
      'SELECT id, question_text FROM questions WHERE category_id = $1',
      [submission.category_id]
    );
    const labelMap = {};
    questions.forEach(q => { labelMap[String(q.id)] = q.question_text; });

    res.json({ submission, images, labelMap, read_only: true });
  } catch (err) { next(err); }
});

router.get('/is-attendee', authenticateToken, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM inspection_schedules WHERE attendee_id = $1 LIMIT 1',
      [req.user.id]
    );
    res.json({ is_attendee: rows.length > 0 });
  } catch (err) { next(err); }
});

module.exports = router;