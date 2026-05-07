const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');

// GET /api/locations — all locations
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM locations ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/locations/:slug/categories — categories for a location
router.get('/:slug/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*
       FROM categories c
       JOIN location_categories lc ON lc.category_id = c.id
       JOIN locations l ON l.id = lc.location_id
       WHERE l.slug = $1
       ORDER BY c.id`,
      [req.params.slug]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/locations — create location
router.post('/', async (req, res, next) => {
  try {
    const { name, slug, description } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO locations (name, slug, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, slug, description]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/locations/:id — update location
router.put('/:id', async (req, res, next) => {
  try {
    const { name, slug, description } = req.body;
    const { rows } = await pool.query(
      `UPDATE locations SET name=$1, slug=$2, description=$3
       WHERE id=$4 RETURNING *`,
      [name, slug, description, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/locations/:id — delete location
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM locations WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/locations/:id/categories-assigned — all categories with assigned flag
router.get('/:id/categories-assigned', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
         CASE WHEN lc.id IS NOT NULL THEN true ELSE false END AS assigned
       FROM categories c
       LEFT JOIN location_categories lc
         ON lc.category_id = c.id AND lc.location_id = $1
       ORDER BY c.id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/locations/:id/categories — assign category to location
router.post('/:id/categories', async (req, res, next) => {
  try {
    const { category_id } = req.body;
    await pool.query(
      `INSERT INTO location_categories (location_id, category_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, category_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});
// GET /api/locations/:id — get single location by id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM locations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Location not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/locations/:id/categories/:categoryId — remove category from location
router.delete('/:id/categories/:categoryId', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM location_categories WHERE location_id=$1 AND category_id=$2',
      [req.params.id, req.params.categoryId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;