const pool = require('./db');

async function createNotification(userId, type, title, message, actionUrl = null) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, action_url)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, actionUrl]
  );
}

async function createNotifications(userIds, type, title, message, actionUrl = null) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, action_url)
     SELECT unnest($1::int[]), $2, $3, $4, $5`,
    [ids, type, title, message, actionUrl]
  );
}

module.exports = { createNotification, createNotifications };
