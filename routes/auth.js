const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db'); // your pg connection

// REGISTER
router.post('/register', async (req, res) => {
  const { username, email, password, location } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (user_id, username, email, password, location)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [`US_${Date.now()}`, username, email, hashedPassword, location]
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