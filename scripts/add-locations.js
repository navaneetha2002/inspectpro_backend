const pool = require('../db/db');

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id          SERIAL       PRIMARY KEY,
      name        VARCHAR(100) NOT NULL UNIQUE,
      slug        VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMP    DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS location_categories (
      id          SERIAL  PRIMARY KEY,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE(location_id, category_id)
    );

    ALTER TABLE form_submissions
      ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL;
  `);

  console.log('Tables created');

  await pool.query(`
    INSERT INTO locations (name, slug, description) VALUES
      ('Bangalore', 'bangalore', 'Tarento Bangalore office'),
      ('Indore',    'indore',    'Tarento Indore office'),
      ('Sweden',    'sweden',    'Tarento Sweden office')
    ON CONFLICT (slug) DO NOTHING;
  `);

  console.log('Locations seeded');

  await pool.query(`
    INSERT INTO location_categories (location_id, category_id)
    SELECT l.id, c.id FROM locations l, categories c
    WHERE l.slug = 'bangalore'
    AND c.slug IN ('kitchen','washroom','desk','frontdesk')
    ON CONFLICT DO NOTHING;

    INSERT INTO location_categories (location_id, category_id)
    SELECT l.id, c.id FROM locations l, categories c
    WHERE l.slug = 'indore'
    AND c.slug IN ('washroom','desk','frontdesk')
    ON CONFLICT DO NOTHING;

    INSERT INTO location_categories (location_id, category_id)
    SELECT l.id, c.id FROM locations l, categories c
    WHERE l.slug = 'sweden'
    AND c.slug IN ('kitchen','washroom','desk','frontdesk')
    ON CONFLICT DO NOTHING;
  `);

  console.log('Location categories seeded');
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });