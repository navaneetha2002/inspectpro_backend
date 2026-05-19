const express = require('express');
const router  = express.Router({ mergeParams: true }); // mergeParams gives access to :uuid
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { createNotifications } = require('../db/notifications');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname).toLowerCase());
    ok ? cb(null, true) : cb(new Error('Only image files allowed'));
  },
});

// ── Helper: resolve submission by uuid, check access ────────────────────────
async function resolveSubmission(uuid, userId, role) {
  const isAdmin = ['global_admin', 'local_admin'].includes(role);
  const { rows } = await pool.query(
    `SELECT fs.*
     FROM form_submissions fs
     WHERE fs.submission_uuid = $1
       AND (
         $2 = TRUE
         OR fs.user_id = $3
         OR EXISTS (
           SELECT 1 FROM inspection_schedules s
           WHERE s.submission_id = fs.id
             AND (s.attendee_id = $3 OR s.assigned_to = $3 OR s.created_by = $3)
         )
       )`,
    [uuid, isAdmin, userId]
  );
  return rows[0] || null;
}


// Returns inspector + attendee (from schedule) + global admins, deduped
async function getNotifyIds(submissionId) {
  const [{ rows: sched }, { rows: admins }] = await Promise.all([
    pool.query(
      'SELECT assigned_to, attendee_id FROM inspection_schedules WHERE submission_id = $1 LIMIT 1',
      [submissionId]
    ),
    pool.query(
      `SELECT id FROM users WHERE role_id IN (SELECT id FROM roles WHERE name = 'global_admin')`
    ),
  ]);
  return [
    ...(sched[0] ? [sched[0].assigned_to, sched[0].attendee_id] : []),
    ...admins.map(r => r.id),
  ].filter(Boolean);
}

// ── GET /api/submissions/:uuid/rounds ────────────────────────────────────────
// Full history of all rounds for a submission
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(
      `SELECT
         ir.id, ir.round_number, ir.status, ir.answers,
         ir.submitted_at, ir.review_notes, ir.reviewed_at,
         reviewer.username  AS reviewed_by_username,
         inspector.username AS inspector_username,

         -- Attendee remarks aggregated
         (
           SELECT json_agg(json_build_object(
             'question_id', ar.question_id,
             'question',    q.question_text,
             'remark',      ar.remark,
             'created_at',  ar.created_at
           ) ORDER BY ar.question_id)
           FROM attendee_remarks ar
           JOIN questions q ON q.id = ar.question_id
           WHERE ar.round_id = ir.id
         ) AS attendee_remarks,

         -- Inspector image ids
         (
           SELECT json_agg(json_build_object('id', ri.id, 'original_name', ri.original_name, 'mimetype', ri.mimetype))
           FROM round_images ri WHERE ri.round_id = ir.id
         ) AS inspector_images,

         -- Attendee image ids
         (
           SELECT json_agg(json_build_object('id', ari.id, 'original_name', ari.original_name, 'mimetype', ari.mimetype))
           FROM attendee_round_images ari WHERE ari.round_id = ir.id
         ) AS attendee_images

       FROM inspection_rounds ir
       LEFT JOIN users reviewer  ON reviewer.id  = ir.reviewed_by
       LEFT JOIN users inspector ON inspector.id = ir.inspector_id
       WHERE ir.submission_id = $1
       ORDER BY ir.round_number ASC`,
      [sub.id]
    );

    res.json({
      submission_uuid: sub.submission_uuid,
      overall_status:  sub.overall_status,
      current_round:   sub.current_round,
      max_rounds:      sub.max_rounds,
      rounds:          rows,
    });
  } catch (err) { next(err); }
});


// ── POST /api/submissions/:uuid/rounds ───────────────────────────────────────
// Inspector submits answers for the current round
router.post('/', authenticateToken,
  authorizeRoles('inspector', 'global_admin', 'local_admin'),
  upload.array('images', 10),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
      if (!sub) return res.status(404).json({ error: 'Not found' });

      // Time-window check for inspectors
      if (req.user.role === 'inspector') {
        const { rows: schedRows } = await pool.query(
          'SELECT scheduled_at, submission_deadline FROM inspection_schedules WHERE submission_id = $1 LIMIT 1',
          [sub.id]
        );
        if (schedRows.length) {
          const now = new Date();
          const { scheduled_at, submission_deadline } = schedRows[0];
          if (scheduled_at && now < new Date(scheduled_at)) {
            return res.status(403).json({ error: 'Inspection has not started yet.' });
          }
          if (submission_deadline && now > new Date(submission_deadline)) {
            return res.status(403).json({ error: 'Submission deadline has passed. Ask your coordinator to extend the deadline.' });
          }
        }
      }

      // Only allow submission if overall_status allows it
      const allowedStatuses = ['pending', 'under_review'];
      if (!allowedStatuses.includes(sub.overall_status)) {
        return res.status(409).json({
          error: `Cannot submit a new round — submission is '${sub.overall_status}'.`
        });
      }

      const answers = JSON.parse(req.body.answers || '{}');
      const roundNumber = sub.current_round;

      await client.query('BEGIN');

      // Upsert the round record
      const { rows: roundRows } = await client.query(
        `INSERT INTO inspection_rounds
           (submission_id, round_number, inspector_id, answers, status, submitted_at)
         VALUES ($1, $2, $3, $4, 'submitted', NOW())
         ON CONFLICT (submission_id, round_number)
         DO UPDATE SET answers = $4, status = 'submitted', submitted_at = NOW()
         RETURNING id`,
        [sub.id, roundNumber, req.user.id, JSON.stringify(answers)]
      );
      const roundId = roundRows[0].id;

      // Save inspector images for this round
      if (req.files?.length) {
        for (const file of req.files) {
          const imageBuffer = fs.readFileSync(file.path);
          await client.query(
            `INSERT INTO round_images
               (round_id, filename, original_name, mimetype, size, image_data)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [roundId, file.filename, file.originalname, file.mimetype, file.size, imageBuffer]
          );
          fs.unlinkSync(file.path);
        }
      }

      // Update overall submission status to 'submitted'
      await client.query(
        `UPDATE form_submissions SET overall_status = 'submitted' WHERE id = $1`,
        [sub.id]
      );

      await client.query('COMMIT');
      res.json({ success: true, round_id: roundId, round_number: roundNumber });

      // Notify inspector, attendee, and global admins
      getNotifyIds(sub.id).then(ids =>
        createNotifications(
          ids,
          'submission',
          `Inspection Submitted — Round ${roundNumber}`,
          `Inspector submitted Round ${roundNumber} inspection for ${sub.submission_uuid}.`,
          `/submissions/${sub.submission_uuid}`
        )
      ).catch(err => console.error('[notifications] inspector-submit failed:', err));

    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);


// ── PATCH /api/submissions/:uuid/rounds/:roundId/decision ────────────────────
// Inspector approves or rejects a round
router.patch('/:roundId/decision', authenticateToken,
  authorizeRoles('inspector', 'global_admin', 'local_admin'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
      if (!sub) return res.status(404).json({ error: 'Not found' });

      const { status, review_notes } = req.body;
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
      }

      // Fetch the round
      const { rows: roundRows } = await pool.query(
        'SELECT * FROM inspection_rounds WHERE id = $1 AND submission_id = $2',
        [req.params.roundId, sub.id]
      );
      if (!roundRows.length) return res.status(404).json({ error: 'Round not found' });
      const round = roundRows[0];

      if (round.status !== 'submitted') {
        return res.status(409).json({ error: `Round is '${round.status}', not 'submitted'.` });
      }

      await client.query('BEGIN');

      // Update the round
      await client.query(
        `UPDATE inspection_rounds
         SET status = $1, review_notes = $2, reviewed_by = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [status, review_notes ?? null, req.user.id, round.id]
      );

      let newOverallStatus;

      if (status === 'approved') {
        newOverallStatus = 'approved';
        // Sync back to legacy status column too
        await client.query(
          `UPDATE form_submissions
           SET overall_status = 'approved', status = 'approved',
               reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
           WHERE id = $3`,
          [req.user.id, review_notes ?? null, sub.id]
        );

      } else {
        // Rejected — check if re-inspection is still allowed
        const canReinspect = sub.current_round < sub.max_rounds;

        if (canReinspect) {
          newOverallStatus = 'rejected';
          await client.query(
            `UPDATE form_submissions SET overall_status = 'rejected', status = 'rejected' WHERE id = $1`,
            [sub.id]
          );
        } else {
          // Max rounds reached — close it
          newOverallStatus = 'closed';
          await client.query(
            `UPDATE form_submissions
             SET overall_status = 'closed', status = 'rejected',
                 reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
             WHERE id = $3`,
            [req.user.id, review_notes ?? null, sub.id]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ success: true, overall_status: newOverallStatus });

      // Notify inspector, attendee, and global admins
      const statusLabel = status === 'approved' ? 'Approved' : 'Rejected';
      getNotifyIds(sub.id).then(ids =>
        createNotifications(
          ids,
          'submission',
          `Round ${round.round_number} ${statusLabel}`,
          `Inspector ${statusLabel.toLowerCase()} Round ${round.round_number}.${review_notes ? ` Notes: ${review_notes}` : ''}`,
          `/submissions/${sub.submission_uuid}`
        )
      ).catch(err => console.error('[notifications] round-decision failed:', err));

    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);


// ── POST /api/submissions/:uuid/rounds/:roundId/remarks ──────────────────────
// Attendee submits per-question remarks after a rejection
router.post('/:roundId/remarks', authenticateToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    if (sub.overall_status !== 'rejected') {
      return res.status(409).json({ error: 'Remarks can only be added when submission is rejected.' });
    }

    // Verify the user is the attendee for this schedule
    const { rows: schedRows } = await pool.query(
      'SELECT id FROM inspection_schedules WHERE submission_id = $1 AND attendee_id = $2',
      [sub.id, req.user.id]
    );
    const isAdmin = ['global_admin', 'local_admin'].includes(req.user.role);
    if (!schedRows.length && !isAdmin) {
      return res.status(403).json({ error: 'Only the attendee can add remarks.' });
    }

    // remarks = [{ question_id, remark }, ...]
    const { remarks } = req.body;
    if (!Array.isArray(remarks) || !remarks.length) {
      return res.status(400).json({ error: 'remarks must be a non-empty array.' });
    }

    await client.query('BEGIN');

    for (const { question_id, remark } of remarks) {
      if (!question_id || !remark?.trim()) continue;
      await client.query(
        `INSERT INTO attendee_remarks (round_id, question_id, remark)
         VALUES ($1, $2, $3)
         ON CONFLICT (round_id, question_id)
         DO UPDATE SET remark = $3`,
        [req.params.roundId, question_id, remark.trim()]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});


// ── POST /api/submissions/:uuid/rounds/:roundId/attendee-images ──────────────
// Attendee uploads evidence images
router.post('/:roundId/attendee-images', authenticateToken,
  upload.array('images', 10),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
      if (!sub) return res.status(404).json({ error: 'Not found' });

      if (sub.overall_status !== 'rejected') {
        return res.status(409).json({ error: 'Images can only be uploaded when submission is rejected.' });
      }

      if (!req.files?.length) return res.status(400).json({ error: 'No images uploaded.' });

      await client.query('BEGIN');
      for (const file of req.files) {
        const imageBuffer = fs.readFileSync(file.path);
        await client.query(
          `INSERT INTO attendee_round_images
             (round_id, filename, original_name, mimetype, size, image_data)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.roundId, file.filename, file.originalname, file.mimetype, file.size, imageBuffer]
        );
        fs.unlinkSync(file.path);
      }
      await client.query('COMMIT');
      res.json({ success: true, count: req.files.length });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);


// ── PATCH /api/submissions/:uuid/rounds/:roundId/attendee-submit ─────────────
// Attendee finalises their review — triggers a new round for the inspector
router.patch('/:roundId/attendee-submit', authenticateToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    if (sub.overall_status !== 'rejected') {
      return res.status(409).json({ error: 'Submission is not in rejected state.' });
    }

    if (sub.current_round >= sub.max_rounds) {
      return res.status(409).json({ error: 'Maximum re-inspections reached.' });
    }

    // Verify attendee
    const { rows: schedRows } = await pool.query(
      'SELECT id FROM inspection_schedules WHERE submission_id = $1 AND attendee_id = $2',
      [sub.id, req.user.id]
    );
    const isAdmin = ['global_admin', 'local_admin'].includes(req.user.role);
    if (!schedRows.length && !isAdmin) {
      return res.status(403).json({ error: 'Only the attendee can submit a review.' });
    }

    const nextRound = sub.current_round + 1;

    await client.query('BEGIN');

    // Create the next round record (pending — waiting for inspector)
    await client.query(
      `INSERT INTO inspection_rounds (submission_id, round_number, inspector_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [sub.id, nextRound, sub.user_id]
    );

    // Advance the submission
    await client.query(
      `UPDATE form_submissions
       SET current_round = $1, overall_status = 'under_review'
       WHERE id = $2`,
      [nextRound, sub.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, next_round: nextRound });

    // Notify inspector, attendee, and global admins
    getNotifyIds(sub.id).then(ids =>
      createNotifications(
        ids,
        'submission',
        `Review Submitted — Round ${nextRound} Ready`,
        `Attendee submitted their review. Round ${nextRound} is ready for reinspection.`,
        `/submissions/${sub.submission_uuid}`
      )
    ).catch(err => console.error('[notifications] attendee-submit failed:', err));

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});


// ── GET /api/submissions/:uuid/history ───────────────────────────────────────
// Full audit trail — all rounds with remarks and image counts
router.get('/history', authenticateToken, async (req, res, next) => {
  try {
    const sub = await resolveSubmission(req.params.uuid, req.user.id, req.user.role);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(
      `SELECT
         ir.id, ir.round_number, ir.status, ir.answers,
         ir.submitted_at, ir.review_notes, ir.reviewed_at,
         reviewer.username  AS reviewed_by_username,
         inspector.username AS inspector_username,
         (
           SELECT json_agg(json_build_object(
             'question_id', ar.question_id,
             'question',    q.question_text,
             'remark',      ar.remark,
             'created_at',  ar.created_at
           ) ORDER BY ar.question_id)
           FROM attendee_remarks ar
           JOIN questions q ON q.id = ar.question_id
           WHERE ar.round_id = ir.id
         ) AS attendee_remarks,
         (SELECT COUNT(*) FROM round_images ri      WHERE ri.round_id  = ir.id) AS inspector_image_count,
         (SELECT COUNT(*) FROM attendee_round_images ari WHERE ari.round_id = ir.id) AS attendee_image_count
       FROM inspection_rounds ir
       LEFT JOIN users reviewer  ON reviewer.id  = ir.reviewed_by
       LEFT JOIN users inspector ON inspector.id = ir.inspector_id
       WHERE ir.submission_id = $1
       ORDER BY ir.round_number ASC`,
      [sub.id]
    );

    res.json({
      submission_uuid: sub.submission_uuid,
      overall_status:  sub.overall_status,
      current_round:   sub.current_round,
      max_rounds:      sub.max_rounds,
      rounds:          rows,
    });
  } catch (err) { next(err); }
});


module.exports = router;