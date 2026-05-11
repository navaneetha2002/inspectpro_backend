const jwt = require('jsonwebtoken');

// Authentication middleware — verifies JWT and sets req.user
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Authorization middleware — restricts access to specific roles
// Usage: authorizeRoles('global_admin', 'local_admin')
const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  }
  next();
};

// Optional auth — sets req.user if a valid token is present, but never blocks the request
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
};

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Static fallback: role → permissions it always has, used when the DB tables aren't seeded yet.
const ROLE_PERMISSIONS = {
  global_admin: '*',
  local_admin:  ['view_submissions',
    'create_submission',
    'delete_submission',
    'view_images',
    'manage_questions',
    'manage_permissions',
    'view_schedules',
    'create_schedule',
    'manage_schedules',],
  coordinator:  ['view_schedules', 'create_schedule', 'view_submissions', 'view_images'],
  inspector:    ['view_schedules', 'create_submission', 'view_submissions', 'view_images'],
  user:         ['create_submission', 'view_submissions'],
};

// Permission-based middleware — checks the role_permissions table, falls back to ROLE_PERMISSIONS.
// Usage: authorizePermission('create_schedule')
const authorizePermission = (permissionName) => async (req, res, next) => {
  const role = req.user.role;

  // global_admin bypasses every permission check
  if (role === 'global_admin') return next();

  try {
    const pool = require('../db/db');
    const { rows } = await pool.query(
      `SELECT 1 FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = rp.role_id
       WHERE r.name = $1 AND p.name = $2`,
      [role, permissionName]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: `Forbidden: requires '${permissionName}' permission` });
    }
    next();
  } catch (err) {
    if (err.code === '42P01') {
      // Tables not seeded yet — fall back to static map
      const allowed = ROLE_PERMISSIONS[role];
      if (allowed === '*' || (Array.isArray(allowed) && allowed.includes(permissionName))) {
        return next();
      }
      return res.status(403).json({ error: `Forbidden: requires '${permissionName}' permission` });
    }
    next(err);
  }
};

module.exports = {
  authenticateToken,
  authorizeRoles,
  optionalAuth,
  authorizePermission,
  requireAuth
};
