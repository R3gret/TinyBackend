require('dotenv').config();
const mysql = require('mysql2');

// Create a connection pool instead of a single connection
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'tiny',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10, // Adjust based on your needs
  queueLimit: 0
});

// Verify the connection
pool.getConnection((err, connection) => {
  if (err) {
   console.error('[DB] Connection failed:', err.code || err.message, err);
  } else {
   console.log('[DB] Connection successful to', process.env.DB_HOST, 'as', process.env.DB_USER);
    connection.release(); // Release the connection back to the pool
  }
});

// Add promise wrapper to allow async/await syntax
const promisePool = pool.promise();

module.exports = {
  pool,
  promisePool
};