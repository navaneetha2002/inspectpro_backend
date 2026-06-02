require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const pool    = require('./db/db');   // ✅ your existing db.js
const { authenticateToken } = require('./middleware/auth');
const roundsRouter = require('./routes/rounds');
const { checkMissedDeadlines, checkMissedAttendeeDeadlines, checkMissedReinspectionDeadlines } = require('./jobs/deadlineNotifier');



const app = express();

// ✅ CORS
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://inspectpro-frontend.cfapps.eu10-004.hana.ondemand.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ ROUTES
app.use('/api/form',        require('./routes/formRoutes'));
app.use('/api/questions', require('./routes/questions'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/locations',   require('./routes/locations'));
app.use('/api/categories',  require('./routes/categories'));
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/permissions', require('./routes/permissions'));
app.use('/api/schedules',      require('./routes/schedules'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/submissions/:uuid/rounds', roundsRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  // Check for missed inspection deadlines every 60 seconds
  checkMissedDeadlines();
  checkMissedAttendeeDeadlines();
  checkMissedReinspectionDeadlines();
  setInterval(checkMissedDeadlines, 60 * 1000);
  setInterval(checkMissedAttendeeDeadlines, 60 * 1000);
  setInterval(checkMissedReinspectionDeadlines, 60 * 1000);
});