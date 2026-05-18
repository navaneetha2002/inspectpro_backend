const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/notifications
// Returns the authenticated user's notifications, newest first (max 50)
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.title, n.message, n.is_read, n.action_url, n.created_at,
              CASE
                WHEN n.type = 'schedule' AND s.assigned_to = n.user_id THEN 'inspector'
                WHEN n.type = 'schedule' AND s.attendee_id = n.user_id THEN 'attendee'
                ELSE NULL
              END AS assigned_role
       FROM notifications n
       LEFT JOIN inspection_schedules s
         ON n.type = 'schedule'
        AND s.id = CAST(NULLIF(SUBSTRING(n.action_url FROM '/schedules/(\\d+)'), '') AS INTEGER)
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/notifications/unread-count
router.get('/unread-count', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ count: rows[0].count });
  } catch (err) { next(err); }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticateToken, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/clear-all
router.delete('/clear-all', authenticateToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/:id
router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
