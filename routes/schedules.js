const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizePermission } = require('../middleware/auth');

// Accepts either a numeric id or a username string; returns the numeric user id or null.
async function resolveUserId(val) {
  if (!val) return null;
  if (!isNaN(val)) return Number(val);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [val]);
  if (!rows.length) throw Object.assign(new Error(`User not found: ${val}`), { status: 400 });
  return rows[0].id;
}

// GET /api/schedules
// Admins see all; others see schedules assigned to them, created by them, or where they are the attendee
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    let query, params;

    if (role === 'global_admin' || role === 'local_admin') {
      query = `
        SELECT s.*,
               u.username   AS assigned_to_name,
               cb.username  AS created_by_name,
               att.username AS attendee_name,
               c.name       AS category_name,
               c.slug       AS category_slug,
               l.name       AS location_name,
               l.slug       AS location_slug,
               fs.submission_uuid
        FROM inspection_schedules s
        LEFT JOIN users u   ON s.assigned_to = u.id
        LEFT JOIN users cb  ON s.created_by  = cb.id
        LEFT JOIN users att ON s.attendee_id = att.id
        LEFT JOIN categories c ON s.category_id = c.id
        LEFT JOIN locations  l ON s.location_id  = l.id
        LEFT JOIN form_submissions fs ON fs.id = s.submission_id
        ORDER BY s.scheduled_at ASC`;
      params = [];
    } else {
      // Coordinators see what they created; inspectors see what's assigned to them
      // Both cases handled by the OR — no role check needed here
      query = `
        SELECT s.*,
               u.username   AS assigned_to_name,
               cb.username  AS created_by_name,
               att.username AS attendee_name,
               c.name       AS category_name,
               c.slug       AS category_slug,
               l.name       AS location_name,
               l.slug       AS location_slug,
               fs.submission_uuid
        FROM inspection_schedules s
        LEFT JOIN users u   ON s.assigned_to = u.id
        LEFT JOIN users cb  ON s.created_by  = cb.id
        LEFT JOIN users att ON s.attendee_id = att.id
        LEFT JOIN categories c ON s.category_id = c.id
        LEFT JOIN locations  l ON s.location_id  = l.id
        LEFT JOIN form_submissions fs ON fs.id = s.submission_id
        WHERE s.assigned_to = $1 OR s.created_by = $1 OR s.attendee_id = $1
        ORDER BY s.scheduled_at ASC`;
      params = [userId];
    }

    console.log('[GET /schedules] userId=', userId, 'role=', role, 'params=', params);
    const { rows } = await pool.query(query, params);
    console.log('[GET /schedules] returned', rows.length, 'schedules');
    rows.forEach(s => {
      console.log(`  -> id=${s.id} assigned_to=${s.assigned_to} created_by=${s.created_by} attendee_id=${s.attendee_id}`);
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/schedules/is-attendee  ← ADD THIS BLOCK
router.get('/is-attendee', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM inspection_schedules WHERE attendee_id = $1 LIMIT 1',
      [req.user.id]
    );
    res.json({ is_attendee: rows.length > 0 });
  } catch (err) { next(err); }
});

// Inspectors — optionally filtered by ?exclude_location_id=X
router.get('/inspectors', authenticateToken, async (req, res) => {
  try {
    const { exclude_location_id } = req.query;
    const params = [];
    let excludeFilter = '';

    if (exclude_location_id) {
      params.push(exclude_location_id);
      excludeFilter = `AND (u.location_id IS NULL OR u.location_id != $${params.length})`;
    }

    const result = await pool.query(
      `SELECT u.id, u.username
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'inspector'
       ${excludeFilter}
       ORDER BY u.username`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch inspectors' });
  }
});


// Attendees except global_admin — optionally filtered by ?location_id=X
router.get('/attendees', authenticateToken, async (req, res) => {
  try {
    const { location_id } = req.query;
    const params = [];
    let locationFilter = '';

    if (location_id) {
      params.push(location_id);
      locationFilter = `AND u.location_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT u.id, u.username
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.name NOT IN ('global_admin')
       ${locationFilter}
       ORDER BY u.username`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendees' });
  }
});

// GET /api/schedules/:id
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              u.username   AS assigned_to_name,
              cb.username  AS created_by_name,
              att.username AS attendee_name,
              c.name       AS category_name,
              c.slug       AS category_slug,
              l.name       AS location_name,
              l.slug       AS location_slug,
              fs.submission_uuid
       FROM inspection_schedules s
       LEFT JOIN users u   ON s.assigned_to = u.id
       LEFT JOIN users cb  ON s.created_by  = cb.id
       LEFT JOIN users att ON s.attendee_id = att.id
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN locations  l ON s.location_id  = l.id
       LEFT JOIN form_submissions fs ON fs.id = s.submission_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });

    // Non-admins can only view schedules assigned to them, created by them, or where they are the attendee
    const { role, id: userId } = req.user;
    if (
      role !== 'global_admin' &&
      role !== 'local_admin'  &&
      rows[0].assigned_to !== userId &&
      rows[0].created_by  !== userId &&
      rows[0].attendee_id !== userId
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/schedules — create a schedule
// Body: { title, category_id, location_id, assigned_to, attendee_id, scheduled_at, due_at, notes }
router.post('/', authenticateToken, authorizePermission('create_schedule'), async (req, res, next) => {
  const { title, category_id, location_id, assigned_to, attendee_id, scheduled_at, due_at, notes } = req.body;

  if (!title || !assigned_to || !scheduled_at) {
    return res.status(400).json({ error: 'title, assigned_to, and scheduled_at are required' });
  }

  try {
    const resolvedAttendeeId = await resolveUserId(attendee_id);
    const { rows } = await pool.query(
      `INSERT INTO inspection_schedules
         (title, category_id, location_id, assigned_to, attendee_id, created_by, scheduled_at, due_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        title,
        category_id       || null,
        location_id       || null,
        assigned_to,
        resolvedAttendeeId,
        req.user.id,
        scheduled_at,
        due_at            || null,
        notes             || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// PUT /api/schedules/:id — full update (admin only)
router.put('/:id', authenticateToken, authorizePermission('manage_schedules'), async (req, res, next) => {
  const { title, category_id, location_id, assigned_to, attendee_id, scheduled_at, due_at, notes, status } = req.body;
  const allowed = ['pending', 'in_progress', 'completed', 'cancelled'];

  if (status && !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
    const resolvedAttendeeId = await resolveUserId(attendee_id);
    const { rows } = await pool.query(
      `UPDATE inspection_schedules SET
         title        = COALESCE($1, title),
         category_id  = COALESCE($2, category_id),
         location_id  = COALESCE($3, location_id),
         assigned_to  = COALESCE($4, assigned_to),
         attendee_id  = COALESCE($5, attendee_id),
         scheduled_at = COALESCE($6, scheduled_at),
         due_at       = COALESCE($7, due_at),
         notes        = COALESCE($8, notes),
         status       = COALESCE($9, status),
         updated_at   = NOW()
       WHERE id = $10
       RETURNING *`,
      [title, category_id, location_id, assigned_to, resolvedAttendeeId, scheduled_at, due_at, notes, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/schedules/:id/status
// Admins: any schedule
// Others: schedules they are assigned to OR created
// Body: { status, submission_uuid? }
router.patch('/:id/status', authenticateToken, async (req, res, next) => {
  const { status, submission_uuid } = req.body;
  const allowed = ['in_progress', 'completed'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const { role, id: userId } = req.user;

    let submission_id = null;
    if (submission_uuid) {
      const { rows: subRows } = await pool.query(
        'SELECT id FROM form_submissions WHERE submission_uuid = $1',
        [submission_uuid]
      );
      if (subRows.length) submission_id = subRows[0].id;
    }

    let whereClause, params;
    if (role === 'global_admin' || role === 'local_admin') {
      whereClause = 'WHERE id = $3';
      params      = [status, submission_id, req.params.id];
    } else {
      whereClause = 'WHERE id = $3 AND (assigned_to = $4 OR created_by = $4)';
      params      = [status, submission_id, req.params.id, userId];
    }

    const { rows } = await pool.query(
      `UPDATE inspection_schedules
         SET status = $1, submission_id = COALESCE($2, submission_id), updated_at = NOW()
       ${whereClause}
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found or unauthorized' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/schedules/:id
router.delete('/:id', authenticateToken, authorizePermission('manage_schedules'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM inspection_schedules WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ message: 'Schedule deleted', id: rows[0].id });
  } catch (err) { next(err); }
});



module.exports = router;