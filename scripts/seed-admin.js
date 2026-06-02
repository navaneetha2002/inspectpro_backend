/**
 * One-time script: seeds the roles table and creates the first global_admin user.
 *
 * Run:                          node scripts/seed-admin.js
 * With a custom password:       ADMIN_PASSWORD=MySecret123 node scripts/seed-admin.js
 */

const bcrypt = require('bcrypt');
const pool   = require('../db/db');

const ADMIN_USERNAME = 'global_admin1';
const ADMIN_EMAIL    = 'admin1@inspectpro.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create roles table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('roles table ready');

    // 2. Seed default roles
    await client.query(`
      INSERT INTO roles (name, description) VALUES
        ('global_admin', 'Full system access; can manage users and roles'),
        ('local_admin',  'Admin for a specific location'),
        ('inspector',    'Performs inspections and submits forms'),
        ('coordinator',  'Coordinates inspection activities'),
        ('user',         'Standard read-only / self-service access')
      ON CONFLICT DO NOTHING
    `);
    console.log('Default roles seeded');

    // 3. Drop old static CHECK constraint if present (safe on fresh DBs too)
    await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');

    // 4. Hash password and upsert global_admin
    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);

    const { rows: roleRows } = await client.query(`SELECT id FROM roles WHERE name = 'global_admin'`);
    if (!roleRows.length) throw new Error('global_admin role not found — run schema first');
    const roleId = roleRows[0].id;

    const userId = `US_ADM_${Date.now()}`.slice(0, 20);
    const result = await client.query(`
      INSERT INTO users (user_id, username, email, password, role_id)
      VALUES ($4, $1, $2, $3, $5)
      ON CONFLICT (username) DO UPDATE
        SET role_id  = EXCLUDED.role_id,
            password = EXCLUDED.password
      RETURNING id, username, email, role_id
    `, [ADMIN_USERNAME, ADMIN_EMAIL, hashed, userId, roleId]);

    console.log('\nglobal_admin user ready:');
    console.log('  id       :', result.rows[0].id);
    console.log('  username :', result.rows[0].username);
    console.log('  email    :', result.rows[0].email);
    console.log('  role_id  :', result.rows[0].role_id);
    console.log('  password :', ADMIN_PASSWORD);
    console.log('\nChange the password after first login!\n');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
