const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const { date } = req.query;
  let connection;

  // Input validation
  if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Date parameter is required in YYYY-MM-DD format' 
    });
  }

  console.log(`Fetching activities for date: ${date}`);

  try {
    connection = await db.promisePool.getConnection();
    await connection.ping(); // Verify connection
    
    const query = `
      SELECT a.* 
      FROM scheduled_activity a
      JOIN weekly_plans w ON a.plan_id = w.plan_id
      WHERE DATE(w.date) = ?
    `;

    const [results] = await connection.query(query, [date]);

    console.log('Activities found:', results);
    res.json({
      success: true,
      activities: results
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error while fetching activities',
      error: err.message
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;