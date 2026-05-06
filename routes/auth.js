const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/db'); // your pg connection

// REGISTER
router.post('/register', async (req, res) => {

  const { username, email, password, location } = req.body;

  const locationResult = await pool.query(
  'SELECT id FROM locations WHERE name = $1',
  [location]   // coming from request body
);
if (locationResult.rows.length === 0) {
  return res.status(400).json({ error: 'Invalid location' });
}
const location_id = locationResult.rows[0].id;

 const userId = `US_${Date.now()}`;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (user_id, username, email, password, location_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, username, email, hashedPassword, location_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'User registration failed' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.rows[0].password);

    if (!valid) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const token = jwt.sign(
      { id: user.rows[0].id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;