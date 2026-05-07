const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// GET /api/submissions
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'global_admin';

    let rows;

    if (isAdmin) {
      // Admin — all submissions + who submitted
      ({ rows } = await pool.query(
        `SELECT fs.*, c.name AS category_name, l.name AS location_name,
                u.username AS submitted_by,
                COUNT(si.id) AS image_count
         FROM form_submissions fs
         LEFT JOIN categories c ON c.id = fs.category_id
         LEFT JOIN locations l ON l.id = fs.location_id
         LEFT JOIN submission_images si ON si.submission_id = fs.id
         LEFT JOIN users u ON u.id = fs.user_id
         GROUP BY fs.id, c.name, l.name, u.username
         ORDER BY fs.submitted_at DESC`
      ));
    } else {
      // Regular user — only their own submissions
      ({ rows } = await pool.query(
        `SELECT fs.*, c.name AS category_name, l.name AS location_name,
                COUNT(si.id) AS image_count
         FROM form_submissions fs
         LEFT JOIN categories c ON c.id = fs.category_id
         LEFT JOIN locations l ON l.id = fs.location_id
         LEFT JOIN submission_images si ON si.submission_id = fs.id
         WHERE fs.user_id = $1
         GROUP BY fs.id, c.name, l.name
         ORDER BY fs.submitted_at DESC`,
        [req.user.id]
      ));
    }

    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/submissions/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT fs.*, c.name AS category_name, l.name AS location_name
       FROM form_submissions fs
       JOIN categories c ON c.id = fs.category_id
       LEFT JOIN locations l ON l.id = fs.location_id
       WHERE fs.submission_uuid=$1`,
      [req.params.uuid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const submission = rows[0];

    const { rows: images } = await pool.query(
      'SELECT id, original_name, mimetype, uploaded_at FROM submission_images WHERE submission_id=$1',
      [submission.id]
    );

    const { rows: questions } = await pool.query(
      'SELECT id, question_text FROM questions WHERE category_id=$1',
      [submission.category_id]
    );

    const labelMap = {};
    questions.forEach(q => { labelMap[String(q.id)] = q.question_text; });

    res.json({ submission, images, labelMap });
  } catch (err) { next(err); }
});

// DELETE /api/submissions/:uuid
router.delete('/:uuid', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM form_submissions WHERE submission_uuid=$1',
      [req.params.uuid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Images are deleted automatically via ON DELETE CASCADE
    await pool.query(
      'DELETE FROM form_submissions WHERE submission_uuid=$1',
      [req.params.uuid]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;