-- ─────────────────────────────────────────────────────────────────────────────
-- InspectPro — Database Schema
-- PostgreSQL
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID extension for submission UUIDs
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
-- 2. QUESTIONS
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
-- 3. LOCATIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP    DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. LOCATION CATEGORIES (many-to-many)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_categories (
  id          SERIAL  PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE(location_id, category_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ROLES
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
-- 6. USERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(20)  UNIQUE NOT NULL,
  username    VARCHAR(100) UNIQUE NOT NULL,
  email       VARCHAR(150) UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role_id     INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default global_admin (password: Admin@123 — change immediately)
INSERT INTO users (user_id, username, email, password, role_id)
SELECT 'US_GLOBAL_ADMIN', 'global_admin', 'admin@inspectpro.com',
       '$2b$10$v3LIiVZ.F0VqpELHRfIIBuQnUSClbaxEjFpbhXOiWrJ3KT5t3u0RO', id
FROM roles WHERE name = 'global_admin'
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. FORM SUBMISSIONS
--    Includes approval/rejection workflow + multi-round re-inspection support
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_submissions (
  id               SERIAL PRIMARY KEY,
  submission_uuid  UUID DEFAULT uuid_generate_v4() UNIQUE,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  location_id      INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  answers          JSONB NOT NULL DEFAULT '{}',
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at     TIMESTAMP DEFAULT NOW(),

  -- ── Approval/rejection (inspector decision) ───────────────────────────────
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_notes     TEXT,

  -- ── Multi-round re-inspection ─────────────────────────────────────────────
  current_round    INT NOT NULL DEFAULT 1,
  max_rounds       INT NOT NULL DEFAULT 3,   -- 1 original + 2 re-inspections
  overall_status   VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (overall_status IN (
      'pending',        -- not yet submitted
      'submitted',      -- inspector submitted, awaiting review
      'approved',       -- inspector approved
      'rejected',       -- inspector rejected, attendee can add remarks
      'under_review',   -- attendee submitted remarks, awaiting re-inspection
      'closed'          -- max rounds reached, no more re-inspections
    ))
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. SUBMISSION IMAGES
--    Legacy images table — kept for backwards compatibility
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
-- 9. INSPECTION ROUNDS
--    One row per inspection attempt. Stores answers + decision per round.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inspection_rounds (
  id            SERIAL PRIMARY KEY,
  submission_id INT NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  round_number  INT NOT NULL DEFAULT 1,
  inspector_id  INT REFERENCES users(id) ON DELETE SET NULL,
  answers       JSONB,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'approved', 'rejected')),
  reviewed_by                  INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                  TIMESTAMPTZ,
  review_notes                 TEXT,
  submitted_at                 TIMESTAMPTZ,
  attendee_review_deadline      TIMESTAMPTZ,
  attendee_deadline_notified_at TIMESTAMPTZ,
  inspector_deadline            TIMESTAMPTZ,
  inspector_deadline_notified_at TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (submission_id, round_number)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. ROUND IMAGES
--     Inspector images scoped to a specific round
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS round_images (
  id            SERIAL PRIMARY KEY,
  round_id      INT NOT NULL REFERENCES inspection_rounds(id) ON DELETE CASCADE,
  filename      TEXT,
  original_name TEXT,
  mimetype      TEXT,
  size          INT,
  image_data    BYTEA,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. ATTENDEE REMARKS
--     Per-question feedback from the attendee after a rejection
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendee_remarks (
  id          SERIAL PRIMARY KEY,
  round_id    INT NOT NULL REFERENCES inspection_rounds(id) ON DELETE CASCADE,
  question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  remark      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (round_id, question_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. ATTENDEE ROUND IMAGES
--     Evidence images uploaded by the attendee during their review
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendee_round_images (
  id            SERIAL PRIMARY KEY,
  round_id      INT NOT NULL REFERENCES inspection_rounds(id) ON DELETE CASCADE,
  filename      TEXT,
  original_name TEXT,
  mimetype      TEXT,
  size          INT,
  image_data    BYTEA,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO permissions (name, description) VALUES
  ('view_submissions',    'Can view form submissions'),
  ('create_submission',   'Can submit inspection forms'),
  ('delete_submission',   'Can delete submissions'),
  ('manage_users',        'Can create, update and delete users'),
  ('manage_roles',        'Can create and delete roles'),
  ('manage_locations',    'Can create, update and delete locations'),
  ('manage_categories',   'Can create, update and delete categories'),
  ('manage_questions',    'Can create, update and delete questions'),
  ('view_images',         'Can view submission images'),
  ('view_schedules',      'Can view inspection schedules'),
  ('create_schedule',     'Can create and assign inspection schedules'),
  ('manage_schedules',    'Can edit and delete any inspection schedule'),
  ('register_user',       'Can register new users')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. ROLE PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  id            SERIAL PRIMARY KEY,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE(role_id, permission_id)
);

-- global_admin gets all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'global_admin'
ON CONFLICT DO NOTHING;

-- local_admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'local_admin'
AND p.name IN (
  'view_submissions','create_submission','delete_submission','view_images',
  'manage_locations','view_schedules','create_schedule','manage_schedules',
  'register_user','manage_questions'
)
ON CONFLICT DO NOTHING;

-- inspector
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'inspector'
AND p.name IN ('create_submission','view_submissions','view_images','view_schedules')
ON CONFLICT DO NOTHING;

-- coordinator
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'coordinator'
AND p.name IN ('view_submissions','view_images','view_schedules','create_schedule')
ON CONFLICT DO NOTHING;

-- user
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'user'
AND p.name IN ('create_submission','view_submissions')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 15. INSPECTION SCHEDULES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inspection_schedules (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  assigned_to   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at          TIMESTAMP NOT NULL,
  due_at                TIMESTAMP,
  submission_deadline   TIMESTAMP,
  deadline_notified_at  TIMESTAMP,
  status                VARCHAR(50) DEFAULT 'pending',
  notes         TEXT,
  submission_id INTEGER REFERENCES form_submissions(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 16. NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(255) NOT NULL,
  message    TEXT,
  is_read    BOOLEAN DEFAULT FALSE,
  action_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, description) VALUES
  ('Cafeteria',  'cafeteria',  'Kitchen area inspection'),
  ('Washroom',   'washroom',   'Washroom area inspection'),
  ('Desk',       'desk',       'Desk / workstation area inspection'),
  ('Reception',  'reception',  'Front desk / reception inspection')
ON CONFLICT DO NOTHING;

INSERT INTO locations (name, slug, description) VALUES
  ('Bangalore', 'bangalore', 'Tarento Bangalore office'),
  ('Indore',    'indore',    'Tarento Indore office'),
  ('Sweden',    'sweden',    'Tarento Sweden office')
ON CONFLICT DO NOTHING;

INSERT INTO location_categories (location_id, category_id)
SELECT l.id, c.id FROM locations l, categories c
WHERE l.slug = 'bangalore'
AND c.slug IN ('cafeteria','washroom','desk','reception')
ON CONFLICT DO NOTHING;

INSERT INTO location_categories (location_id, category_id)
SELECT l.id, c.id FROM locations l, categories c
WHERE l.slug = 'indore'
AND c.slug IN ('washroom','desk','reception')
ON CONFLICT DO NOTHING;

INSERT INTO location_categories (location_id, category_id)
SELECT l.id, c.id FROM locations l, categories c
WHERE l.slug = 'sweden'
AND c.slug IN ('cafeteria','washroom','desk','reception')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Questions
CREATE INDEX IF NOT EXISTS idx_questions_category_id  ON questions(category_id);
CREATE INDEX IF NOT EXISTS idx_questions_order         ON questions(category_id, order_index);
CREATE INDEX IF NOT EXISTS idx_questions_conditional   ON questions(conditional_on_question_id)
  WHERE conditional_on_question_id IS NOT NULL;

-- Submissions
CREATE INDEX IF NOT EXISTS idx_submissions_uuid        ON form_submissions(submission_uuid);
CREATE INDEX IF NOT EXISTS idx_submissions_user_id     ON form_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status      ON form_submissions(overall_status);

-- Submission images
CREATE INDEX IF NOT EXISTS idx_submission_images_submission_id
  ON submission_images(submission_id);

-- Inspection rounds
CREATE INDEX IF NOT EXISTS idx_inspection_rounds_submission
  ON inspection_rounds(submission_id);

-- Attendee remarks
CREATE INDEX IF NOT EXISTS idx_attendee_remarks_round
  ON attendee_remarks(round_id);

-- Round images
CREATE INDEX IF NOT EXISTS idx_round_images_round
  ON round_images(round_id);

-- Attendee round images
CREATE INDEX IF NOT EXISTS idx_attendee_round_images_round
  ON attendee_round_images(round_id);

-- Schedules
CREATE INDEX IF NOT EXISTS idx_schedules_assigned_to   ON inspection_schedules(assigned_to);
CREATE INDEX IF NOT EXISTS idx_schedules_attendee_id   ON inspection_schedules(attendee_id);
CREATE INDEX IF NOT EXISTS idx_schedules_scheduled_at  ON inspection_schedules(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_schedules_status        ON inspection_schedules(status);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread    ON notifications(user_id, is_read);