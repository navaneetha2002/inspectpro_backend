-- ─────────────────────────────────────────────────────────────────────────────

-- InspectPro — Database Schema

-- PostgreSQL

-- ─────────────────────────────────────────────────────────────────────────────

 

-- Enable UUID extension for submission UUIDs

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 1. CATEGORIES

--    Represents the inspection areas (Kitchen, Washroom, Desk, Front Desk)

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (

  id          SERIAL PRIMARY KEY,

  name        VARCHAR(100) NOT NULL UNIQUE,

  slug        VARCHAR(100) NOT NULL UNIQUE,  -- used in URLs e.g. /form/kitchen

  description TEXT,

  created_at  TIMESTAMP DEFAULT NOW()

);

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 2. QUESTIONS

--    Stores all form questions linked to a category.

--    - field_type controls how the question renders in the form

--    - options stores choices for select/radio types as a JSON array

--    - order_index controls display sequence within a category

--    - conditional_on_question_id + conditional_on_value allow a question

--      to appear only when another question has a specific answer

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS questions (

  id                          SERIAL PRIMARY KEY,

  category_id                 INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,

  question_text               TEXT NOT NULL,

 

  -- field_type options:

  --   text     → single line text input

  --   textarea → multi-line text input

  --   number   → numeric input

  --   yesno    → Yes / No radio buttons

  --   select   → dropdown list  (requires options)

  --   radio    → radio buttons  (requires options)

  field_type                  VARCHAR(50) NOT NULL DEFAULT 'text',

 

  options                     JSONB,         -- e.g. ["Poor","Fair","Good","Excellent"]

  order_index                 INTEGER NOT NULL DEFAULT 0,

 

  -- Conditional display:

  -- Show this question only when the answer to `conditional_on_question_id`

  -- equals `conditional_on_value` (case-insensitive comparison in frontend)

  conditional_on_question_id  INTEGER REFERENCES questions(id) ON DELETE SET NULL,

  conditional_on_value        TEXT,

 

  is_required                 BOOLEAN DEFAULT TRUE,

  created_at                  TIMESTAMP DEFAULT NOW(),

  updated_at                  TIMESTAMP DEFAULT NOW()

);

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 3. FORM SUBMISSIONS

--    One row per completed inspection form submission.

--    All answers are stored as a JSONB blob keyed by question ID.

--    e.g. answers: { "12": "Yes", "13": "Poor", "15": "Needs cleaning" }

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS form_submissions (

  id               SERIAL PRIMARY KEY,

  submission_uuid  UUID DEFAULT uuid_generate_v4() UNIQUE,

  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,

  answers          JSONB NOT NULL DEFAULT '{}',

  submitted_at     TIMESTAMP DEFAULT NOW()

);

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 4. SUBMISSION IMAGES

--    Images uploaded as part of a submission.

--    Binary image data is stored directly in PostgreSQL as BYTEA.

--    Served back to the client via GET /api/form/image/:id

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS submission_images (

  id             SERIAL PRIMARY KEY,

  submission_id  INTEGER NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,

  filename       VARCHAR(500) NOT NULL,   -- stored filename on disk (temp, then deleted)

  original_name  VARCHAR(500),            -- original filename from user's device

  mimetype       VARCHAR(100),            -- e.g. image/jpeg

  size           INTEGER,                 -- file size in bytes

  image_data     BYTEA,                   -- actual binary image stored in DB

  uploaded_at    TIMESTAMP DEFAULT NOW()

);

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- INDEXES

-- ─────────────────────────────────────────────────────────────────────────────

 

-- Speed up form loading (most common query: fetch questions by category)

CREATE INDEX IF NOT EXISTS idx_questions_category_id

  ON questions(category_id);

 

-- Speed up ordering of questions

CREATE INDEX IF NOT EXISTS idx_questions_order

  ON questions(category_id, order_index);

 

-- Speed up conditional question lookups

CREATE INDEX IF NOT EXISTS idx_questions_conditional

  ON questions(conditional_on_question_id)

  WHERE conditional_on_question_id IS NOT NULL;

 

-- Speed up submission lookups by UUID (used in thank-you page and detail view)

CREATE INDEX IF NOT EXISTS idx_submissions_uuid

  ON form_submissions(submission_uuid);

 

-- Speed up fetching images for a submission

CREATE INDEX IF NOT EXISTS idx_submission_images_submission_id

  ON submission_images(submission_id);

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- SEED DATA — Categories

-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO categories (name, slug, description) VALUES

  ('Cafeteria', 'kitchen', 'Kitchen area inspection'),

  ('Washroom', 'washroom', 'Washroom area inspection'),

  ('Desk', 'desk', 'Desk / workstation area inspection'),

  ('Reception', 'frontdesk', 'Front desk / reception inspection')

ON CONFLICT DO NOTHING;

 

-- Locations table

CREATE TABLE IF NOT EXISTS locations (

  id          SERIAL       PRIMARY KEY,

  name        VARCHAR(100) NOT NULL UNIQUE,

  slug        VARCHAR(100) NOT NULL UNIQUE,

  description TEXT,

  created_at  TIMESTAMP    DEFAULT NOW()

);

 

-- Link categories to locations (many-to-many)

CREATE TABLE IF NOT EXISTS location_categories (

  id          SERIAL  PRIMARY KEY,

  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,

  UNIQUE(location_id, category_id)

);

 

-- Add location_id to form_submissions

ALTER TABLE form_submissions

  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL;

 

-- Ensure slug and description columns exist (in case table was created without them)

ALTER TABLE locations ADD COLUMN IF NOT EXISTS slug        VARCHAR(100) UNIQUE;

ALTER TABLE locations ADD COLUMN IF NOT EXISTS description TEXT;

 

-- Seed locations

INSERT INTO locations (name, slug, description) VALUES

  ('Bangalore', 'bangalore', 'Tarento Bangalore office'),

  ('Indore',    'indore',    'Tarento Indore office'),

  ('Sweden',    'sweden',    'Tarento Sweden office')

ON CONFLICT DO NOTHING;

 

-- Seed location_categories

-- Bangalore: all 4 categories

INSERT INTO location_categories (location_id, category_id)

SELECT l.id, c.id FROM locations l, categories c

WHERE l.slug = 'bangalore'

AND c.slug IN ('cafeteria','washroom','desk','reception')

ON CONFLICT DO NOTHING;

 

-- Indore: no cafeteria, has wellness room

INSERT INTO location_categories (location_id, category_id)

SELECT l.id, c.id FROM locations l, categories c

WHERE l.slug = 'indore'

AND c.slug IN ('washroom','desk','reception','wellness')

ON CONFLICT DO NOTHING;

 

-- Sweden: all + gaming area

INSERT INTO location_categories (location_id, category_id)

SELECT l.id, c.id FROM locations l, categories c

WHERE l.slug = 'sweden'

AND c.slug IN ('cafeteria','washroom','desk','reception','gaming')

ON CONFLICT DO NOTHING;

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 5. ROLES

--    Stores all valid roles. global_admin can add new roles at runtime.

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (

  id          SERIAL PRIMARY KEY,

  name        VARCHAR(100) NOT NULL UNIQUE,

  description TEXT,

  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

 

-- Seed default roles

INSERT INTO roles (name, description) VALUES

  ('global_admin',  'Full system access; can manage users and roles'),

  ('local_admin',   'Admin for a specific location'),

  ('inspector',     'Performs inspections and submits forms'),

  ('coordinator',   'Coordinates inspection activities'),

  ('user',          'Standard read-only / self-service access')

ON CONFLICT DO NOTHING;

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 6. USERS

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (

  id SERIAL PRIMARY KEY,

 

  user_id VARCHAR(20) UNIQUE NOT NULL,   -- e.g. US_001

  username VARCHAR(100) UNIQUE NOT NULL,

  email VARCHAR(150) UNIQUE NOT NULL,

 

  password TEXT NOT NULL,

  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,

 

  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,

 

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

 

-- Drop old static CHECK constraint if it exists (for existing databases)

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

 

-- Migration: add role_id column for existing databases

ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;

 

-- Migration: populate role_id from existing role name column

UPDATE users SET role_id = roles.id FROM roles WHERE users.role = roles.name AND users.role_id IS NULL;

 

-- Add user_id to form_submissions (references users, so must come after users table)

ALTER TABLE form_submissions

  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

 

-- Seed a default global_admin (password: Admin@123 — change immediately)

INSERT INTO users (user_id, username, email, password, role_id)

SELECT 'US_GLOBAL_ADMIN', 'global_admin', 'admin@inspectpro.com',

       '$2b$10$v3LIiVZ.F0VqpELHRfIIBuQnUSClbaxEjFpbhXOiWrJ3KT5t3u0RO', id

FROM roles WHERE name = 'global_admin'

ON CONFLICT DO NOTHING;

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 7. PERMISSIONS

--    Defines all available permissions in the system.

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS permissions (

  id          SERIAL PRIMARY KEY,

  name        VARCHAR(100) NOT NULL UNIQUE,  -- e.g. 'view_submissions'

  description TEXT,

  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

 

-- Seed default permissions

INSERT INTO permissions (name, description) VALUES

  ('view_submissions',    'Can view form submissions'),

  ('create_submission',   'Can submit inspection forms'),

  ('delete_submission',   'Can delete submissions'),

  ('manage_users',        'Can create, update and delete users'),

  ('manage_roles',        'Can create and delete roles'),

  ('manage_locations',    'Can create, update and delete locations'),

  ('manage_categories',   'Can create, update and delete categories'),

  ('manage_questions',    'Can create, update and delete questions'),

  ('view_images',         'Can view submission images')

ON CONFLICT DO NOTHING;

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 8. ROLE PERMISSIONS

--    Maps which permissions each role has.

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS role_permissions (

  id            SERIAL PRIMARY KEY,

  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,

  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,

  UNIQUE(role_id, permission_id)

);

 

-- Migration: add role_id column if table already exists

ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE;

 

-- Seed default role_permissions

-- global_admin gets all permissions

INSERT INTO role_permissions (role_id, permission_id)

SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'global_admin'

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

-- 9. SCHEDULE PERMISSIONS

-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO permissions (name, description) VALUES

  ('view_schedules',   'Can view inspection schedules'),

  ('create_schedule',  'Can create and assign inspection schedules'),

  ('manage_schedules', 'Can edit and delete any inspection schedule')

ON CONFLICT DO NOTHING;

 

-- global_admin already gets all permissions via the wildcard seed above

 

-- local_admin: full schedule control

INSERT INTO role_permissions (role_id, permission_id)

SELECT r.id, p.id FROM roles r, permissions p

WHERE r.name = 'local_admin'

AND p.name IN ('view_schedules', 'create_schedule', 'manage_schedules')

ON CONFLICT DO NOTHING;

 

-- inspector: can only view their assigned schedules

INSERT INTO role_permissions (role_id, permission_id)

SELECT r.id, p.id FROM roles r, permissions p

WHERE r.name = 'inspector'

AND p.name IN ('view_schedules')

ON CONFLICT DO NOTHING;

 

-- coordinator: can view schedules

INSERT INTO role_permissions (role_id, permission_id)

SELECT r.id, p.id FROM roles r, permissions p

WHERE r.name = 'coordinator'

AND p.name IN ('view_schedules', 'create_schedule')

ON CONFLICT DO NOTHING;

 

 

-- ─────────────────────────────────────────────────────────────────────────────

-- 10. INSPECTION SCHEDULES

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inspection_schedules (

  id            SERIAL PRIMARY KEY,

  title         VARCHAR(255) NOT NULL,

  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,

  location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,

  assigned_to   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  scheduled_at  TIMESTAMP NOT NULL,

  due_at        TIMESTAMP,

  status        VARCHAR(50) DEFAULT 'pending',  -- pending | in_progress | completed | cancelled

  notes         TEXT,

  submission_id INTEGER REFERENCES form_submissions(id) ON DELETE SET NULL,

  created_at    TIMESTAMP DEFAULT NOW(),

  updated_at    TIMESTAMP DEFAULT NOW()

);

ALTER TABLE inspection_schedules

  ADD COLUMN IF NOT EXISTS attendee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

 

CREATE INDEX IF NOT EXISTS idx_schedules_attendee_id ON inspection_schedules(attendee_id);

 

CREATE INDEX IF NOT EXISTS idx_schedules_assigned_to  ON inspection_schedules(assigned_to);

CREATE INDEX IF NOT EXISTS idx_schedules_scheduled_at ON inspection_schedules(scheduled_at);

CREATE INDEX IF NOT EXISTS idx_schedules_status       ON inspection_schedules(status);