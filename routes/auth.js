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

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // Get current count of users to generate sequential ID
    const countResult = await pool.query('SELECT COUNT(*) FROM users');
    const count       = parseInt(countResult.rows[0].count) + 1;
    const userId      = `US_${String(count).padStart(3, '0')}`;  // US_001, US_002...

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
  const { email, password } = req.body;

  try {
    const user = await pool.query(
      'SELECT u.*, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.email = $1',
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.rows[0].password);

    if (!valid) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const token = jwt.sign(
      { 
        id: user.rows[0].id, 
        email: user.rows[0].email,
        role: user.rows[0].role,
        location_id: user.rows[0].location_id,
        location: user.rows[0].location_name
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET ALL USERS
router.get('/users', async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT u.id, u.user_id, u.username, u.email, u.role, u.location_id, 
             l.name as location_name, u.created_at
      FROM users u 
      LEFT JOIN locations l ON u.location_id = l.id 
      ORDER BY u.created_at DESC
    `);

    res.json(users.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET SPECIFIC USER
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const user = await pool.query(`
      SELECT u.id, u.user_id, u.username, u.email, u.role, u.location_id,
             l.name as location_name, u.created_at
      FROM users u 
      LEFT JOIN locations l ON u.location_id = l.id 
      WHERE u.id = $1 OR u.user_id = $1
    `, [id]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

module.exports = router;