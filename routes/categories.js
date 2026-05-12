const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// GET /api/categories
router.get('/', authenticateToken,async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/categories
router.post('/', authenticateToken, authorizeRoles('global_admin'), async (req, res, next) => {
  try {
    const { name, slug, description } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO categories (name, slug, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, slug, description]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/categories/:id
router.put('/:id', authenticateToken, authorizeRoles('global_admin'), async (req, res, next) => {
  try {
    const { name, slug, description } = req.body;
    const { rows } = await pool.query(
      `UPDATE categories SET name=$1, slug=$2, description=$3 WHERE id=$4 RETURNING *`,
      [name, slug, description, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/categories/:id
router.delete('/:id', authenticateToken, authorizeRoles('global_admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;