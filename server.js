require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const pool    = require('./db/db');   // ✅ your existing db.js
const { authenticateToken } = require('./middleware/auth');



const app = express();

// ✅ CORS
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://inspectpro-frontend.cfapps.eu10-004.hana.ondemand.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ ROUTES
app.use('/api/form',        require('./routes/formRoutes'));
app.use('/api/questions', authenticateToken, require('./routes/questions'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/locations',   require('./routes/locations'));
app.use('/api/categories',  require('./routes/categories'));
app.use('/api/auth', require('./routes/auth'));

const PORT = process.env.PORT || 3000;

// ✅ 🔥 ADD THIS BLOCK (IMPORTANT)
async function initDB() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    await pool.query(schema);

    console.log('✅ Database schema initialized');
  } catch (err) {
    console.error('❌ Error initializing DB:', err);
  }
}

// ✅ Start server AFTER DB init
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
  });
});