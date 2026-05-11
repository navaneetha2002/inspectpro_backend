const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizePermission } = require('../middleware/auth');

// GET /api/schedules
// Admins see all; others see schedules assigned to them OR created by them
router.get('/', authenticateToken, authorizePermission('view_schedules'), async (req, res, next) => {
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
               l.slug       AS location_slug
        FROM inspection_schedules s
        LEFT JOIN users u   ON s.assigned_to = u.id
        LEFT JOIN users cb  ON s.created_by  = cb.id
        LEFT JOIN users att ON s.attendee_id = att.id
        LEFT JOIN categories c ON s.category_id = c.id
        LEFT JOIN locations  l ON s.location_id  = l.id
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
               l.slug       AS location_slug
        FROM inspection_schedules s
        LEFT JOIN users u   ON s.assigned_to = u.id
        LEFT JOIN users cb  ON s.created_by  = cb.id
        LEFT JOIN users att ON s.attendee_id = att.id
        LEFT JOIN categories c ON s.category_id = c.id
        LEFT JOIN locations  l ON s.location_id  = l.id
        WHERE s.assigned_to = $1 OR s.created_by = $1
        ORDER BY s.scheduled_at ASC`;
      params = [userId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/schedules/:id
router.get('/:id', authenticateToken, authorizePermission('view_schedules'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              u.username   AS assigned_to_name,
              cb.username  AS created_by_name,
              att.username AS attendee_name,
              c.name       AS category_name,
              c.slug       AS category_slug,
              l.name       AS location_name,
              l.slug       AS location_slug
       FROM inspection_schedules s
       LEFT JOIN users u   ON s.assigned_to = u.id
       LEFT JOIN users cb  ON s.created_by  = cb.id
       LEFT JOIN users att ON s.attendee_id = att.id
       LEFT JOIN categories c ON s.category_id = c.id
       LEFT JOIN locations  l ON s.location_id  = l.id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });

    // Non-admins can only view schedules assigned to them OR created by them
    const { role, id: userId } = req.user;
    if (
      role !== 'global_admin' &&
      role !== 'local_admin'  &&
      rows[0].assigned_to !== userId &&
      rows[0].created_by  !== userId
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
    const { rows } = await pool.query(
      `INSERT INTO inspection_schedules
         (title, category_id, location_id, assigned_to, attendee_id, created_by, scheduled_at, due_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        title,
        category_id  || null,
        location_id  || null,
        assigned_to,
        attendee_id  || null,
        req.user.id,
        scheduled_at,
        due_at       || null,
        notes        || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/schedules/:id — full update (admin only)
router.put('/:id', authenticateToken, authorizePermission('manage_schedules'), async (req, res, next) => {
  const { title, category_id, location_id, assigned_to, attendee_id, scheduled_at, due_at, notes, status } = req.body;
  const allowed = ['pending', 'in_progress', 'completed', 'cancelled'];

  if (status && !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
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
      [title, category_id, location_id, assigned_to, attendee_id, scheduled_at, due_at, notes, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/schedules/:id/status
// Admins: any schedule
// Others: schedules they are assigned to OR created
router.patch('/:id/status', authenticateToken, authorizePermission('view_schedules'), async (req, res, next) => {
  const { status } = req.body;
  const allowed = ['in_progress', 'completed'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const { role, id: userId } = req.user;

    let whereClause, params;
    if (role === 'global_admin' || role === 'local_admin') {
      whereClause = 'WHERE id = $2';
      params      = [status, req.params.id];
    } else {
      whereClause = 'WHERE id = $2 AND (assigned_to = $3 OR created_by = $3)';
      params      = [status, req.params.id, userId];
    }

    const { rows } = await pool.query(
      `UPDATE inspection_schedules SET status = $1, updated_at = NOW() ${whereClause} RETURNING *`,
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