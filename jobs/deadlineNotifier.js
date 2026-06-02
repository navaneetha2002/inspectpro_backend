const pool = require('../db/db');
const { createNotifications } = require('../db/notifications');

async function checkMissedAttendeeDeadlines() {
  try {
    // Rounds where attendee review deadline passed and attendee hasn't submitted yet
    const { rows: overdue } = await pool.query(
      `SELECT ir.id AS round_id, ir.round_number, ir.attendee_review_deadline,
              fs.submission_uuid,
              s.created_by  AS coordinator_id,
              s.assigned_to AS inspector_id,
              s.location_id
       FROM inspection_rounds ir
       JOIN form_submissions fs ON fs.id = ir.submission_id
       LEFT JOIN inspection_schedules s ON s.submission_id = fs.id
       WHERE ir.attendee_review_deadline < NOW()
         AND ir.attendee_review_deadline IS NOT NULL
         AND ir.attendee_deadline_notified_at IS NULL
         AND ir.status = 'rejected'
         AND fs.overall_status = 'rejected'`
    );

    if (!overdue.length) return;

    for (const round of overdue) {
      // global_admin + local_admin of the schedule's location + coordinator + inspector
      const { rows: admins } = await pool.query(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name = 'global_admin'
            OR (r.name = 'local_admin' AND ($1::int IS NULL OR u.location_id = $1))`,
        [round.location_id]
      );

      const notifyIds = [
        ...admins.map(r => r.id),
        round.coordinator_id,
        round.inspector_id,
      ].filter(Boolean);
      const uniqueIds = [...new Set(notifyIds)];

      await createNotifications(
        uniqueIds,
        'submission',
        `Missed Review Deadline — Round ${round.round_number}`,
        `Attendee did not submit their review for Round ${round.round_number} before the deadline.`,
        `/submissions/${round.submission_uuid}`
      );

      await pool.query(
        'UPDATE inspection_rounds SET attendee_deadline_notified_at = NOW() WHERE id = $1',
        [round.round_id]
      );

      console.log(`[deadline-notifier] attendee missed review deadline for round id=${round.round_id}`);
    }
  } catch (err) {
    console.error('[deadline-notifier] attendee check error:', err.message);
  }
}

async function checkMissedDeadlines() {
  try {
    // Find schedules where:
    // - deadline has passed
    // - notification not yet sent
    // - inspector never submitted (submission_id IS NULL)
    //   OR it's a reinspection round still pending for the inspector
    const { rows: overdue } = await pool.query(
      `SELECT s.id, s.title, s.created_by, s.attendee_id
       FROM inspection_schedules s
       WHERE s.submission_deadline < NOW()
         AND s.submission_deadline IS NOT NULL
         AND s.deadline_notified_at IS NULL
         AND (
           s.submission_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM form_submissions fs
             JOIN inspection_rounds ir
               ON ir.submission_id = fs.id
              AND ir.round_number  = fs.current_round
             WHERE fs.id              = s.submission_id
               AND fs.overall_status  = 'under_review'
               AND ir.status          = 'pending'
           )
         )`
    );

    if (!overdue.length) return;

    const { rows: admins } = await pool.query(
      `SELECT id FROM users
       WHERE role_id IN (SELECT id FROM roles WHERE name = 'global_admin')`
    );
    const adminIds = admins.map(r => r.id);

    for (const schedule of overdue) {
      const notifyIds = [...new Set([...adminIds, schedule.created_by, schedule.attendee_id].filter(Boolean))];

      await createNotifications(
        notifyIds,
        'schedule',
        `Missed Deadline: ${schedule.title}`,
        `Inspector did not submit the inspection "${schedule.title}" before the deadline.`,
        `/schedules/${schedule.id}`
      );

      await pool.query(
        'UPDATE inspection_schedules SET deadline_notified_at = NOW() WHERE id = $1',
        [schedule.id]
      );

      console.log(`[deadline-notifier] notified for schedule id=${schedule.id} "${schedule.title}"`);
    }
  } catch (err) {
    console.error('[deadline-notifier] error:', err.message);
  }
}

async function checkMissedReinspectionDeadlines() {
  try {
    // Rounds where inspector_deadline passed and inspector hasn't submitted yet
    const { rows: overdue } = await pool.query(
      `SELECT ir.id AS round_id, ir.round_number,
              fs.submission_uuid,
              s.created_by  AS coordinator_id,
              s.assigned_to AS inspector_id,
              s.location_id
       FROM inspection_rounds ir
       JOIN form_submissions fs ON fs.id = ir.submission_id
       LEFT JOIN inspection_schedules s ON s.submission_id = fs.id
       WHERE ir.inspector_deadline < NOW()
         AND ir.inspector_deadline IS NOT NULL
         AND ir.inspector_deadline_notified_at IS NULL
         AND ir.status = 'pending'
         AND ir.round_number > 1`
    );

    if (!overdue.length) return;

    for (const round of overdue) {
      const { rows: admins } = await pool.query(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name = 'global_admin'
            OR (r.name = 'local_admin' AND ($1::int IS NULL OR u.location_id = $1))`,
        [round.location_id]
      );

      const notifyIds = [...new Set([
        ...admins.map(r => r.id),
        round.coordinator_id,
        round.inspector_id,
      ].filter(Boolean))];

      await createNotifications(
        notifyIds,
        'submission',
        `Missed Reinspection Deadline — Round ${round.round_number}`,
        `Inspector did not complete Round ${round.round_number} reinspection before the deadline.`,
        `/submissions/${round.submission_uuid}`
      );

      await pool.query(
        'UPDATE inspection_rounds SET inspector_deadline_notified_at = NOW() WHERE id = $1',
        [round.round_id]
      );

      console.log(`[deadline-notifier] inspector missed reinspection deadline for round id=${round.round_id}`);
    }
  } catch (err) {
    console.error('[deadline-notifier] reinspection check error:', err.message);
  }
}

module.exports = { checkMissedDeadlines, checkMissedAttendeeDeadlines, checkMissedReinspectionDeadlines };
