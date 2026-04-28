const express = require('express');
const router  = express.Router();
const pool    = require('../db/db');

function normaliseQuestions(rows) {
  return rows.map(q => {
    if (q.options && typeof q.options !== 'string') {
      q.options = JSON.stringify(q.options);
    }
    return q;
  });
}

// GET /api/questions
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.*, c.name AS category_name
       FROM questions q
       JOIN categories c ON c.id = q.category_id
       ORDER BY c.id, q.order_index`
    );
    res.json(normaliseQuestions(rows));
  } catch (err) { next(err); }
});

// GET /api/questions/all  (for dropdowns — no category filter)
router.get('/all', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, question_text, field_type, options FROM questions ORDER BY order_index'
    );
    res.json(normaliseQuestions(rows));
  } catch (err) { next(err); }
});

// GET /api/questions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM questions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(normaliseQuestions(rows)[0]);
  } catch (err) { next(err); }
});

// POST /api/questions
router.post('/', async (req, res, next) => {
  try {
    const {
      category_id, question_text, field_type, options_raw,
      order_index, conditional_on_question_id,
      conditional_on_value, is_required,
    } = req.body;

    const options = options_raw?.trim()
      ? JSON.stringify(options_raw.split('\n').map(s => s.trim()).filter(Boolean))
      : null;

    const { rows } = await pool.query(
      `INSERT INTO questions
         (category_id, question_text, field_type, options, order_index,
          conditional_on_question_id, conditional_on_value, is_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        category_id, question_text, field_type, options,
        order_index || 0,
        conditional_on_question_id || null, conditional_on_value || null,
        is_required === true || is_required === 'true',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/questions/:id
router.put('/:id', async (req, res, next) => {
  try {
    const {
      category_id, question_text, field_type, options_raw,
      order_index, conditional_on_question_id,
      conditional_on_value, is_required,
    } = req.body;

    const options = options_raw?.trim()
      ? JSON.stringify(options_raw.split('\n').map(s => s.trim()).filter(Boolean))
      : null;

    const { rows } = await pool.query(
      `UPDATE questions SET
         category_id=$1, question_text=$2, field_type=$3, options=$4,
         order_index=$5, conditional_on_question_id=$6,
         conditional_on_value=$7, is_required=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [
        category_id, question_text, field_type, options,
        order_index || 0,
        conditional_on_question_id || null, conditional_on_value || null,
        is_required === true || is_required === 'true',
        req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/questions/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;