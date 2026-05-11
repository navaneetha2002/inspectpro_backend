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

// Permission-based middleware — checks the role_permissions table in the DB
// Usage: authorizePermission('create_schedule')
const authorizePermission = (permissionName) => async (req, res, next) => {
  try {
    const pool = require('../db/db');
    const { rows } = await pool.query(
      `SELECT 1 FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = rp.role_id
       WHERE r.name = $1 AND p.name = $2`,
      [req.user.role, permissionName]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: `Forbidden: requires '${permissionName}' permission` });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  authenticateToken,
  authorizeRoles,
  optionalAuth,
  authorizePermission
};
