const pool = require('../db/db');
const { createNotifications } = require('../db/notifications');

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

module.exports = { checkMissedDeadlines };
