-- ─────────────────────────────────────────────────────────────────────────────
-- InspectPro — Database Schema
-- PostgreSQL
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CATEGORIES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. LOCATIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP    DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LOCATION CATEGORIES (many-to-many)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_categories (
  id          SERIAL  PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE(location_id, category_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ROLES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO roles (name, description) VALUES
  ('global_admin',  'Full system access; can manage users and roles'),
  ('local_admin',   'Admin for a specific location'),
  ('inspector',     'Performs inspections and submits forms'),
  ('coordinator',   'Coordinates inspection activities'),
  ('user',          'Standard read-only / self-service access')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. USERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(20)  UNIQUE NOT NULL,
  username    VARCHAR(100) UNIQUE NOT NULL,
  email       VARCHAR(150) UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        VARCHAR(100) DEFAULT 'user' REFERENCES roles(name) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. QUESTIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id                          SERIAL PRIMARY KEY,
  category_id                 INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  question_text               TEXT NOT NULL,
  field_type                  VARCHAR(50) NOT NULL DEFAULT 'text',
  options                     JSONB,
  order_index                 INTEGER NOT NULL DEFAULT 0,
  conditional_on_question_id  INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  conditional_on_value        TEXT,
  is_required                 BOOLEAN DEFAULT TRUE,
  created_at                  TIMESTAMP DEFAULT NOW(),
  updated_at                  TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. FORM SUBMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_submissions (
  id               SERIAL PRIMARY KEY,
  submission_uuid  UUID DEFAULT uuid_generate_v4() UNIQUE,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  location_id      INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  answers          JSONB NOT NULL DEFAULT '{}',
  submitted_at     TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. SUBMISSION IMAGES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submission_images (
  id             SERIAL PRIMARY KEY,
  submission_id  INTEGER NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  filename       VARCHAR(500) NOT NULL,
  original_name  VARCHAR(500),
  mimetype       VARCHAR(100),
  size           INTEGER,
  image_data     BYTEA,
  uploaded_at    TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO permissions (name, description) VALUES
  ('view_submissions',  'Can view form submissions'),
  ('create_submission', 'Can submit inspection forms'),
  ('delete_submission', 'Can delete submissions'),
  ('manage_users',      'Can create, update and delete users'),
  ('manage_roles',      'Can create and delete roles'),
  ('manage_locations',  'Can create, update and delete locations'),
  ('manage_categories', 'Can create, update and delete categories'),
  ('manage_questions',  'Can create, update and delete questions'),
  ('view_images',       'Can view submission images')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. ROLE PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  id            SERIAL PRIMARY KEY,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE(role_id, permission_id)
);

-- global_admin gets all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'global_admin'
ON CONFLICT DO NOTHING;

-- local_admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'local_admin'
AND p.name IN ('view_submissions','create_submission','delete_submission','view_images','manage_locations')
ON CONFLICT DO NOTHING;

-- inspector
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'inspector'
AND p.name IN ('create_submission','view_submissions','view_images')
ON CONFLICT DO NOTHING;

-- coordinator
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'coordinator'
AND p.name IN ('view_submissions','view_images')
ON CONFLICT DO NOTHING;

-- user
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'user'
AND p.name IN ('create_submission','view_submissions')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_questions_category_id
  ON questions(category_id);
CREATE INDEX IF NOT EXISTS idx_questions_order
  ON questions(category_id, order_index);
CREATE INDEX IF NOT EXISTS idx_questions_conditional
  ON questions(conditional_on_question_id)
  WHERE conditional_on_question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submissions_uuid
  ON form_submissions(submission_uuid);
CREATE INDEX IF NOT EXISTS idx_submissions_category
  ON form_submissions(category_id);
CREATE INDEX IF NOT EXISTS idx_images_submission_id
  ON submission_images(submission_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, description) VALUES
  ('Cafeteria', 'kitchen',   'Kitchen area inspection'),
  ('Washroom',  'washroom',  'Washroom area inspection'),
  ('Desk',      'desk',      'Desk / workstation area inspection'),
  ('Reception', 'frontdesk', 'Front desk / reception inspection')
ON CONFLICT DO NOTHING;

INSERT INTO locations (name, slug, description) VALUES
  ('Bangalore', 'bangalore', 'Tarento Bangalore office'),
  ('Indore',    'indore',    'Tarento Indore office'),
  ('Sweden',    'sweden',    'Tarento Sweden office')
ON CONFLICT DO NOTHING;

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

-- Default global_admin user (password: Admin@123)
INSERT INTO users (user_id, username, email, password, role)
VALUES (
  'US_GLOBAL_ADMIN',
  'global_admin',
  'admin@inspectpro.com',
  '$2b$10$v3LIiVZ.F0VqpELHRfIIBuQnUSClbaxEjFpbhXOiWrJ3KT5t3u0RO',
  'global_admin'
)
ON CONFLICT DO NOTHING;

ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE;
 