const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://inspectpro-frontend.cfapps.eu10-004.hana.ondemand.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
})); // Vite dev server
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/form',        require('./routes/formRoutes'));
app.use('/api/questions',   require('./routes/questions'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/locations',    require('./routes/locations'));
app.use('/api/categories', require('./routes/categories'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});