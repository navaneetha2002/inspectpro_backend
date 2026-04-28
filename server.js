const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app = express();

app.use(cors({ origin: 'http://localhost:5173' })); // Vite dev server
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/form',        require('./routes/formRoutes'));
app.use('/api/questions',   require('./routes/questions'));
app.use('/api/submissions', require('./routes/submissions'));

app.listen(3000, () => console.log('Backend running on http://localhost:3000'));