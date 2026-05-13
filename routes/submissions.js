const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// GET /api/submissions
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { role, id: userId, location_id } = req.user;

    let rows;

    if (role === 'global_admin') {
      // Global admin — all submissions
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
    } else if (role === 'local_admin') {
      // Local admin — all submissions from their location
      ({ rows } = await pool.query(
        `SELECT fs.*, c.name AS category_name, l.name AS location_name,
                u.username AS submitted_by,
                COUNT(si.id) AS image_count
         FROM form_submissions fs
         LEFT JOIN categories c ON c.id = fs.category_id
         LEFT JOIN locations l ON l.id = fs.location_id
         LEFT JOIN submission_images si ON si.submission_id = fs.id
         LEFT JOIN users u ON u.id = fs.user_id
         WHERE fs.location_id = $1
         GROUP BY fs.id, c.name, l.name, u.username
         ORDER BY fs.submitted_at DESC`,
        [location_id]
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
        [userId]
      ));
    }

    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/submissions/:uuid
router.get('/:uuid', authenticateToken, async (req, res, next) => {
  try {

    const { role, id: userId, location_id } = req.user;

    let query;
    let values;

    if (role === 'global_admin') {
      query = `
        SELECT fs.*, c.name AS category_name, l.name AS location_name
        FROM form_submissions fs
        LEFT JOIN categories c ON c.id = fs.category_id
        LEFT JOIN locations l ON l.id = fs.location_id
        WHERE fs.submission_uuid=$1
      `;
      values = [req.params.uuid];
    } else if (role === 'local_admin') {
      query = `
        SELECT fs.*, c.name AS category_name, l.name AS location_name
        FROM form_submissions fs
        LEFT JOIN categories c ON c.id = fs.category_id
        LEFT JOIN locations l ON l.id = fs.location_id
        WHERE fs.submission_uuid=$1 AND fs.location_id=$2
      `;
      values = [req.params.uuid, location_id];
    } else {
      query = `
        SELECT fs.*, c.name AS category_name, l.name AS location_name
        FROM form_submissions fs
        LEFT JOIN categories c ON c.id = fs.category_id
        LEFT JOIN locations l ON l.id = fs.location_id
        WHERE fs.submission_uuid=$1
        AND (
            fs.user_id = $2
            OR EXISTS (
              SELECT 1 FROM inspection_schedules s
              WHERE s.submission_id = fs.id
                AND s.attendee_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM inspection_schedules s
              WHERE s.submission_id = fs.id
                AND s.created_by = $2
            )
          )
      `;
      values = [req.params.uuid, userId];
    }

     const { rows } = await pool.query(query, values);
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
router.delete('/:uuid', authenticateToken, authorizeRoles('global_admin', 'local_admin'), async (req, res, next) => {
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