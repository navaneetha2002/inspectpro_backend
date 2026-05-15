const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken } = require('../middleware/auth');
const { createNotifications } = require('../db/notifications');

// GET /api/permissions
// Returns all available permissions
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM permissions ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/permissions/roles
// Returns all roles with their assigned permissions
router.get('/roles', authenticateToken, async (req, res, next) => {
  try {
    const { rows: roles } = await pool.query('SELECT id, name, description FROM roles ORDER BY name');

    const { rows: rolePerms } = await pool.query(
      `SELECT rp.role_id, p.id, p.name, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       ORDER BY rp.role_id, p.name`
    );

    // Group permissions by role
    const result = roles.map(role => ({
      role_id: role.id,
      role: role.name,
      description: role.description,
      permissions: rolePerms
        .filter(rp => rp.role_id === role.id)
        .map(rp => ({ id: rp.id, name: rp.name, description: rp.description }))
    }));

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/permissions/roles/:roleName
// Returns permissions for a specific role
router.get('/roles/:roleName', authenticateToken, async (req, res, next) => {
  try {
    const { roleName } = req.params;

    const { rows: role } = await pool.query('SELECT * FROM roles WHERE name = $1', [roleName]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });

    const { rows: perms } = await pool.query(
      `SELECT p.id, p.name, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.name`,
      [role[0].id]
    );

    res.json({ role_id: role[0].id, role: roleName, permissions: perms });
  } catch (err) { next(err); }
});

// PUT /api/permissions/roles/:roleName
// global_admin only — replace all permissions for a role
// Body: { permissions: [1, 3, 5] }  (array of permission IDs)
router.put('/roles/:roleName', authenticateToken, async (req, res, next) => {
  if (req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can manage permissions' });
  }

  const { roleName } = req.params;
  const { permissions } = req.body;

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions must be an array of permission IDs' });
  }

  const client = await pool.connect();
  try {
    const { rows: role } = await pool.query('SELECT * FROM roles WHERE name = $1', [roleName]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });
    const roleId = role[0].id;

    await client.query('BEGIN');

    // Remove existing permissions for this role
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);

    // Insert new permissions
    if (permissions.length > 0) {
      const values = permissions.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [roleId, ...permissions]
      );
    }

    await client.query('COMMIT');

    // Return updated permissions
    const { rows: updated } = await pool.query(
      `SELECT p.id, p.name, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.name`,
      [roleId]
    );

    res.json({ role_id: roleId, role: roleName, permissions: updated });

    // Notify all users with this role (fire-and-forget)
    pool.query('SELECT id FROM users WHERE role_id = $1', [roleId])
      .then(({ rows: affected }) => createNotifications(
        affected.map(u => u.id),
        'permission',
        'Permissions Updated',
        `Your role (${roleName}) permissions have been updated by an administrator`,
        '/settings'
      ))
      .catch(err => console.error('[notifications] permission trigger failed:', err));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/permissions/roles/:roleName
// global_admin only — add multiple permissions to a role (without removing existing ones)
// Body: { permissions: [1, 3, 5] }
router.post('/roles/:roleName', authenticateToken, async (req, res, next) => {
  if (req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can manage permissions' });
  }

  const { roleName } = req.params;
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return res.status(400).json({ error: 'permissions must be a non-empty array of permission IDs' });
  }

  const client = await pool.connect();
  try {
    const { rows: role } = await pool.query('SELECT * FROM roles WHERE name = $1', [roleName]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });
    const roleId = role[0].id;

    await client.query('BEGIN');

    const values = permissions.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      [roleId, ...permissions]
    );

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(
      `SELECT p.id, p.name, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.name`,
      [roleId]
    );

    res.json({ role_id: roleId, role: roleName, permissions: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/permissions/roles/:roleName/:permissionId
// global_admin only — add a single permission to a role
router.post('/roles/:roleName/:permissionId', authenticateToken, async (req, res, next) => {
  if (req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can manage permissions' });
  }

  const { roleName, permissionId } = req.params;

  try {
    const { rows: role } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });

    await pool.query(
      'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [role[0].id, permissionId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/permissions/roles/:roleName/:permissionId
// global_admin only — remove a single permission from a role
router.delete('/roles/:roleName/:permissionId', authenticateToken, async (req, res, next) => {
  if (req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can manage permissions' });
  }

  const { roleName, permissionId } = req.params;

  try {
    const { rows: role } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });

    await pool.query(
      'DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2',
      [role[0].id, permissionId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
