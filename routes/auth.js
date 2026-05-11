const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Helper: get role by name, returns role row or null
async function getRoleByName(name) {
  const r = await pool.query('SELECT * FROM roles WHERE name = $1', [name]);
  return r.rows.length > 0 ? r.rows[0] : null;
}

const excelUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      /\.(xlsx|xls)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Only .xlsx / .xls files are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

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
      const roleRow = await getRoleByName(role || 'user');
      if (!roleRow) return res.status(400).json({ error: 'Invalid role' });

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

      const countResult = await pool.query('SELECT COUNT(*) FROM users');
      const count       = parseInt(countResult.rows[0].count) + 1;
      const userId      = `US_${String(count).padStart(3, '0')}`;
      const hashedPassword = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO users (user_id, username, email, password, role, location_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, username, email, role, location_id, created_at`,
        [userId, username, email, hashedPassword, roleRow.name, location_id]
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
      `SELECT u.* FROM users u WHERE u.username = $1`,
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
      { id: user.id, user_id: user.user_id, username: user.username, role: user.role, location_id: user.location_id },
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

  const roleRow = await getRoleByName(role);
  if (!roleRow) {
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

    const countResult = await pool.query('SELECT COUNT(*) FROM users');
    const count       = parseInt(countResult.rows[0].count) + 1;
    const userId      = `US_${String(count).padStart(3, '0')}`;
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (user_id, username, email, password, role, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, username, email, role, location_id, created_at`,
      [userId, username, email, hashedPassword, roleRow.name, location_id]
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

// ─── DOWNLOAD BULK UPLOAD TEMPLATE (global_admin only) ───────────────────────
// GET /api/auth/users/bulk/template
router.get('/users/bulk/template', authenticateToken, authorizeRoles('global_admin'), async (req, res) => {
  try {
    const rolesRes = await pool.query('SELECT name FROM roles ORDER BY name');
    const roleNames = rolesRes.rows.map(r => r.name).join(', ');

    const locsRes = await pool.query('SELECT name FROM locations ORDER BY name');
    const locationNames = locsRes.rows.map(r => r.name).join(', ');

    const wb = xlsx.utils.book_new();

    const templateRows = [
      {
        username: 'john_doe',
        email: 'john@example.com',
        password: 'Pass@123',
        role: 'inspector',
        location: locsRes.rows[0]?.name || '',
      },
      {
        username: 'jane_smith',
        email: 'jane@example.com',
        password: 'Pass@123',
        role: 'local_admin',
        location: locsRes.rows[0]?.name || '',
      },
    ];

    const ws = xlsx.utils.json_to_sheet(templateRows, {
      header: ['username', 'email', 'password', 'role', 'location'],
    });

    // Column widths
    ws['!cols'] = [
      { wch: 20 },
      { wch: 28 },
      { wch: 16 },
      { wch: 18 },
      { wch: 18 },
    ];

    xlsx.utils.book_append_sheet(wb, ws, 'Users');

    // Notes sheet so the admin knows valid values
    const notesRows = [
      { field: 'username', notes: 'Required. Must be unique.' },
      { field: 'email',    notes: 'Required. Must be unique.' },
      { field: 'password', notes: 'Required. Plain text — will be hashed on import.' },
      { field: 'role',     notes: `Required. Valid values: ${roleNames}` },
      { field: 'location', notes: `Optional. Valid values: ${locationNames}` },
    ];
    const wsNotes = xlsx.utils.json_to_sheet(notesRows, { header: ['field', 'notes'] });
    wsNotes['!cols'] = [{ wch: 12 }, { wch: 60 }];
    xlsx.utils.book_append_sheet(wb, wsNotes, 'Instructions');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="bulk_users_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate template' });
  }
});

// ─── BULK CREATE USERS via Excel (global_admin only) ─────────────────────────
// POST /api/auth/users/bulk
// Form-data key: "file"  (.xlsx or .xls)
// Required columns: username | email | password | role
// Optional column : location
router.post(
  '/users/bulk',
  authenticateToken,
  authorizeRoles('global_admin'),
  (req, res, next) => {
    excelUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required — set form-data key to "file" and type to File' });
    }

    // ── Parse workbook ──────────────────────────────────────────────────────
    let rows;
    try {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
    } catch {
      return res.status(400).json({ error: 'Could not parse Excel file' });
    }

    if (!rows.length) {
      return res.status(400).json({ error: 'The sheet has no data rows' });
    }

    // Normalise header keys: trim + lowercase
    const normalise = (raw) => {
      const out = {};
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        out[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : String(v).trim();
      }
      return out;
    };

    // Validate required columns are present
    const firstRow = normalise(rows[0]);
    const detectedCols = Object.keys(firstRow);
    const requiredCols = ['username', 'email', 'password', 'role'];
    const missingCols = requiredCols.filter(c => !detectedCols.includes(c));
    if (missingCols.length > 0) {
      return res.status(400).json({
        error: 'Missing required columns in Excel file',
        missing_columns: missingCols,
        detected_columns: detectedCols,
        expected_columns: [...requiredCols, 'location (optional)'],
      });
    }

    // ── Pre-fetch reference data once ──────────────────────────────────────
    const [rolesRes, locsRes, countRes] = await Promise.all([
      pool.query('SELECT name FROM roles'),
      pool.query('SELECT id, name FROM locations'),
      pool.query('SELECT COUNT(*) FROM users'),
    ]);

    const validRoles  = new Set(rolesRes.rows.map((r) => r.name));
    const locationMap = new Map(locsRes.rows.map((l) => [l.name.toLowerCase(), l.id]));
    let nextCount     = parseInt(countRes.rows[0].count, 10);

    // ── Process each row ────────────────────────────────────────────────────
    const results = [];
    let insertedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row    = normalise(rows[i]);
      const rowNum = i + 2; // row 1 = header
      const { username, email, password, role, location } = row;

      // Validation
      if (!username || !email || !password || !role) {
        results.push({ row: rowNum, username: username || '', status: 'failed', reason: 'username, email, password and role are required' });
        continue;
      }
      if (!validRoles.has(role)) {
        results.push({ row: rowNum, username, status: 'failed', reason: `Invalid role "${role}". Valid: ${[...validRoles].join(', ')}` });
        continue;
      }

      let location_id = null;
      if (location) {
        location_id = locationMap.get(location.toLowerCase());
        if (!location_id) {
          results.push({ row: rowNum, username, status: 'failed', reason: `Invalid location "${location}"` });
          continue;
        }
      }

      // Insert
      try {
        nextCount++;
        const userId         = `US_${String(nextCount).padStart(3, '0')}`;
        const hashedPassword = await bcrypt.hash(password, 10);

        const roleRow = await getRoleByName(role);
        const ins = await pool.query(
          `INSERT INTO users (user_id, username, email, password, role, location_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, user_id, username, email, role, location_id, created_at`,
          [userId, username, email, hashedPassword, roleRow.name, location_id]
        );

        results.push({ row: rowNum, username, status: 'success', user: ins.rows[0] });
        insertedCount++;
      } catch (err) {
        nextCount--;
        results.push({
          row: rowNum,
          username,
          status: 'failed',
          reason: err.code === '23505' ? 'Username or email already exists' : 'Database error',
        });
      }
    }

    res.status(insertedCount > 0 ? 201 : 400).json({
      total: rows.length,
      inserted: insertedCount,
      failed: rows.length - insertedCount,
      results,
    });
  }
);

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
    const roleRow = await getRoleByName(role);
    if (!roleRow) {
      const all = await pool.query('SELECT name FROM roles ORDER BY name');
      const names = all.rows.map(r => r.name).join(', ');
      return res.status(400).json({ error: `Invalid role. Valid roles: ${names}` });
    }

    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, user_id, username, email, role, location_id, created_at`,
      [roleRow.name, id]
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