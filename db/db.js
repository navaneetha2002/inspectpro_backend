const { Pool } = require('pg');
require('dotenv').config();

function getDbConfig() {
  // Running on BTP — credentials come from VCAP_SERVICES
  if (process.env.VCAP_SERVICES) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);

    // BTP PostgreSQL service key is usually 'postgresql-db' or 'postgres'
    const pgService = vcap['postgresql-db'] || vcap['postgres'];

    if (pgService && pgService.length > 0) {
      const creds = pgService[0].credentials;
      return {
        host:     creds.hostname  || creds.host,
         port:     parseInt(creds.port),
        database: creds.dbname    || creds.name,
        user:     creds.username  || creds.user,
        password: creds.password,
        ssl:      creds.sslrootcert
                    ? { rejectUnauthorized: false, ca: creds.sslrootcert }
                    : { rejectUnauthorized: false },
      };
    }
  }

    // Running locally — fall back to .env
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 5432,
    database: process.env.DB_NAME     || 'company_form',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

const pool = new Pool(getDbConfig());

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error:', err);
});

module.exports = pool;