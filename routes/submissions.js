const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { createNotification, createNotifications } = require('../db/notifications');

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
                r.username AS reviewed_by_username,
                COUNT(si.id) AS image_count,
                (SELECT title FROM inspection_schedules WHERE submission_id = fs.id LIMIT 1) AS schedule_title,
                (SELECT id FROM inspection_schedules WHERE submission_id = fs.id LIMIT 1) AS schedule_id
         FROM form_submissions fs
         LEFT JOIN categories c ON c.id = fs.category_id
         LEFT JOIN locations l ON l.id = fs.location_id
         LEFT JOIN submission_images si ON si.submission_id = fs.id
         LEFT JOIN users u ON u.id = fs.user_id
         LEFT JOIN users r ON r.id = fs.reviewed_by
         GROUP BY fs.id, c.name, l.name, u.username, r.username
         ORDER BY fs.submitted_at DESC`
      ));
    } else {
      // Regular user — only their own submissions
      ({ rows } = await pool.query(
        `SELECT fs.*, c.name AS category_name, l.name AS location_name,
                COUNT(si.id) AS image_count,
                (SELECT title FROM inspection_schedules WHERE submission_id = fs.id LIMIT 1) AS schedule_title,
                (SELECT id FROM inspection_schedules WHERE submission_id = fs.id LIMIT 1) AS schedule_id
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
router.get('/:uuid', authenticateToken, async (req, res, next) => {
  try {

     const isAdmin = req.user.role === 'global_admin';

    let query;
    let values;

     if (isAdmin) {

      // Admin can view any submission
      query = `
        SELECT fs.*, c.name AS category_name, l.name AS location_name,
               r.username AS reviewed_by_username,
               sched.schedule_id, sched.attendee_id, sched.assigned_to, sched.title AS schedule_title
        FROM form_submissions fs
        LEFT JOIN categories c ON c.id = fs.category_id
        LEFT JOIN locations l ON l.id = fs.location_id
        LEFT JOIN users r ON r.id = fs.reviewed_by
        LEFT JOIN LATERAL (
          SELECT id AS schedule_id, attendee_id, assigned_to, title FROM inspection_schedules
          WHERE submission_id = fs.id LIMIT 1
        ) sched ON TRUE
        WHERE fs.submission_uuid=$1
      `;

      values = [req.params.uuid];

    } else {
       // Normal user can only view their own submission
      query = `
        SELECT fs.*, c.name AS category_name, l.name AS location_name,
               r.username AS reviewed_by_username,
               sched.schedule_id, sched.attendee_id, sched.assigned_to, sched.title AS schedule_title
        FROM form_submissions fs
        LEFT JOIN categories c ON c.id = fs.category_id
        LEFT JOIN locations l ON l.id = fs.location_id
        LEFT JOIN users r ON r.id = fs.reviewed_by
        LEFT JOIN LATERAL (
          SELECT id AS schedule_id, attendee_id, assigned_to, title FROM inspection_schedules
          WHERE submission_id = fs.id LIMIT 1
        ) sched ON TRUE
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

      values = [req.params.uuid, req.user.id];
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

// PATCH /api/submissions/:uuid/status
// Inspector (or admin) approves or rejects a submission.
router.patch(
  '/:uuid/status',
  authenticateToken,
  authorizeRoles('global_admin', 'local_admin', 'inspector'), // adjust roles as needed
  async (req, res, next) => {
    try {
      const { status, review_notes } = req.body;

      // Validate incoming status
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
      }

      // Fetch the submission so we can check it exists + isn't already decided
      const { rows } = await pool.query(
        'SELECT id, status FROM form_submissions WHERE submission_uuid = $1',
        [req.params.uuid]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });

      const submission = rows[0];

      // Prevent re-reviewing an already decided submission (remove if you want to allow it)
      if (submission.status !== 'pending') {
        return res.status(409).json({
          error: `Submission is already '${submission.status}' and cannot be changed.`
        });
      }

      const { rows: updated } = await pool.query(
        `UPDATE form_submissions
         SET status       = $1,
            overall_status = $1,
             review_notes = $2,
             reviewed_by  = $3,
             reviewed_at  = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, review_notes ?? null, req.user.id, submission.id]
      );

      res.json({ success: true, submission: updated[0] });

      // Notify attendee (and admins) when inspector rejects the initial inspection
      if (status === 'rejected') {
        const actionUrl = `/submissions/${req.params.uuid}`;
        pool.query(
          'SELECT assigned_to, attendee_id FROM inspection_schedules WHERE submission_id = $1 LIMIT 1',
          [submission.id]
        ).then(async ({ rows: sched }) => {
          const { rows: admins } = await pool.query(
            `SELECT id FROM users WHERE role_id IN (SELECT id FROM roles WHERE name = 'global_admin')`
          );
          const adminIds    = admins.map(r => r.id);
          const attendeeId  = sched[0]?.attendee_id;
          const inspectorId = sched[0]?.assigned_to;

          const notesStr = review_notes ? ` Notes: ${review_notes}.` : '';

          if (attendeeId) {
            await createNotification(
              attendeeId, 'submission',
              'Inspection Rejected — Action Required',
              `Your inspection was rejected.${notesStr} Please review and resubmit.`,
              actionUrl
            );
          }

          const othersIds = [...new Set([inspectorId, ...adminIds].filter(id => id && id !== attendeeId))];
          if (othersIds.length) {
            await createNotifications(
              othersIds, 'submission',
              'Inspection Rejected',
              `Inspector rejected the inspection.${notesStr}`,
              actionUrl
            );
          }
        }).catch(err => console.error('[notifications] initial-rejection failed:', err));
      }
    } catch (err) { next(err); }
  }
);

// DELETE /api/submissions/:uuid
router.delete('/:uuid', authenticateToken, authorizeRoles('global_admin', 'local_admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM form_submissions WHERE submission_uuid=$1',
      [req.params.uuid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const submissionId = rows[0].id;

    // Delete linked schedule before submission (FK is ON DELETE SET NULL, so do it first)
    await pool.query(
      'DELETE FROM inspection_schedules WHERE submission_id = $1',
      [submissionId]
    );

    // Images and rounds are deleted automatically via ON DELETE CASCADE
    await pool.query(
      'DELETE FROM form_submissions WHERE id=$1',
      [submissionId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});
// GET /api/submissions/image/:id
router.get('/image/:id', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT image_data, mimetype, original_name FROM submission_images WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Image not found' });

    const image = rows[0];
    res.set('Content-Type', image.mimetype || 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${image.original_name}"`);
    res.send(image.image_data);
  } catch (err) { next(err); }
});
module.exports = router;