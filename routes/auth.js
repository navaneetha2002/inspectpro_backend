const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Helper: check role exists in the DB roles table
async function roleExists(name) {
  const r = await pool.query('SELECT 1 FROM roles WHERE name = $1', [name]);
  return r.rows.length > 0;
}

// ─── REGISTER (requires JWT authentication) ──────────────────────────────────
router.post(
  '/register',
  authenticateToken,
  async (req, res) => {
    // ✅ Check role from JWT — only global_admin can register new users
    if (req.user.role !== 'global_admin') {
      return res.status(403).json({ error: 'Forbidden: only global_admin can register new users' });
    }

    const { username, email, password, location, role } = req.body;

    try {
      // ✅ Fetch valid roles dynamically from DB instead of hardcoded constant
      if (role) {
        const roleResult = await pool.query(
          'SELECT name FROM roles WHERE name = $1',
          [role]
        );
        if (roleResult.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid role' });
        }
      }

      let location_id = null;
      if (location) {
        const locationResult = await pool.query(
          'SELECT id FROM locations WHERE name = $1',
          [location]
        );
        if (locationResult.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid location' });
        }
        location_id = locationResult.rows[0].id;
      }

      const userId = `US_${Date.now()}`;
      const hashedPassword = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO users (user_id, username, email, password, role, location_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, username, email, role, location_id, created_at`,
        [userId, username, email, hashedPassword, role || 'user', location_id]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username or email already exists' });
      }
      res.status(500).json({ error: 'User registration failed' });
    }
  }
);

// ─── LOGIN ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const token = jwt.sign(
      { id: user.id, user_id: user.user_id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        location_id: user.location_id
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── CREATE USER  (global_admin only) ────────────────────────────────────────
// POST /api/auth/users
// Body: { username, email, password, role, location? }
router.post('/users', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  if (!req.user || req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can create users' });
  }

  const { username, email, password, role, location } = req.body;

  if (!username || !email || !password || !role) {
    return res.status(400).json({ error: 'username, email, password and role are required' });
  }

  if (!(await roleExists(role))) {
    const all = await pool.query('SELECT name FROM roles ORDER BY name');
    const names = all.rows.map(r => r.name).join(', ');
    return res.status(400).json({ error: `Invalid role. Valid roles: ${names}` });
  }

  try {
    let location_id = null;
    if (location) {
      const locationResult = await pool.query(
        'SELECT id FROM locations WHERE name = $1',
        [location]
      );
      if (locationResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid location' });
      }
      location_id = locationResult.rows[0].id;
    }

    const userId = `US_${Date.now()}`;
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (user_id, username, email, password, role, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, username, email, role, location_id, created_at`,
      [userId, username, email, hashedPassword, role, location_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ─── LIST ALL USERS  (global_admin only) ─────────────────────────────────────
// GET /api/auth/users
router.get('/users', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.user_id, u.username, u.email, u.role,
              u.location_id, l.name AS location_name, u.created_at
       FROM users u
       LEFT JOIN locations l ON l.id = u.location_id
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── UPDATE USER ROLE  (global_admin only) ───────────────────────────────────
// PUT /api/auth/users/:id/role
// Body: { role }
router.put('/users/:id/role', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'role is required' });
  }

  try {
    if (!(await roleExists(role))) {
      const all = await pool.query('SELECT name FROM roles ORDER BY name');
      const names = all.rows.map(r => r.name).join(', ');
      return res.status(400).json({ error: `Invalid role. Valid roles: ${names}` });
    }

    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, user_id, username, email, role, location_id, created_at`,
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ─── DELETE USER  (global_admin only) ────────────────────────────────────────
// DELETE /api/auth/users/:id
router.delete('/users/:id', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, username',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: `User '${result.rows[0].username}' deleted successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── LIST ALL ROLES  (global_admin only) ────────────────────────────────────
// GET /api/auth/roles
router.get('/roles', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM roles ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// ─── CREATE ROLE  (global_admin only) ────────────────────────────────────────
// POST /api/auth/roles
// Body: { name, description? }
router.post('/roles', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  if (!req.user || req.user.role !== 'global_admin') {
    return res.status(403).json({ error: 'Forbidden: only global_admin can create roles' });
  }

  const { name, description } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Role name is required' });
  }

  // Normalise: lowercase, spaces → underscores
  const normalised = name.trim().toLowerCase().replace(/\s+/g, '_');

  try {
    const result = await pool.query(
      `INSERT INTO roles (name, description) VALUES ($1, $2)
       RETURNING *`,
      [normalised, description || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: `Role '${normalised}' already exists` });
    }
    res.status(500).json({ error: 'Failed to create role' });
  }
});

// ─── UPDATE ROLE DESCRIPTION  (global_admin only) ────────────────────────────
// PUT /api/auth/roles/:name
// Body: { description }
router.put('/roles/:name', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  const { name } = req.params;
  const { description } = req.body;

  try {
    const result = await pool.query(
      `UPDATE roles SET description = $1 WHERE name = $2 RETURNING *`,
      [description, name]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ─── DELETE ROLE  (global_admin only) ────────────────────────────────────────
// DELETE /api/auth/roles/:name
// Note: users assigned this role will fall back to the DEFAULT ('user')
router.delete('/roles/:name', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  const { name } = req.params;

  const protected_roles = ['global_admin', 'user'];
  if (protected_roles.includes(name)) {
    return res.status(400).json({ error: `Role '${name}' is protected and cannot be deleted` });
  }

  try {
    const result = await pool.query(
      'DELETE FROM roles WHERE name = $1 RETURNING name',
      [name]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }
    res.json({ message: `Role '${name}' deleted successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

module.exports = router;