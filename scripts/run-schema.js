const pool = require('../db/db');
const fs   = require('fs');
const path = require('path');

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied successfully');
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });