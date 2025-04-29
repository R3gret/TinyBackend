const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/get_activities?date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const { date } = req.query;
  let connection;

  console.log(`Fetching activities for date: ${date}`);

  try {
    connection = await db.promisePool.getConnection();
    
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
    console.error('Error fetching activities:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch activities' 
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;