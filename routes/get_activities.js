// routes/activities.js
const express = require('express');
const router = express.Router();
const db = require('../db'); // Assuming db is set up for your MySQL connection

// GET /api/get_activities?date=YYYY-MM-DD
router.get('/get_activities', (req, res) => {
  const { date } = req.query;

  console.log(`Fetching activities for date: ${date}`);

  // SQL query to fetch activities for the given date
  const query = `
    SELECT a.* 
    FROM scheduled_activity a
    JOIN weekly_plans w ON a.plan_id = w.plan_id
    WHERE DATE(w.date) = ?
  `;

  // Execute the query with a callback function
  db.query(query, [date], (err, results) => {
    if (err) {
      console.error('Error fetching activities:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch activities' });
    }

    // Return the activities if found
    console.log('Activities found:', results);
    res.json({
      success: true,
      activities: results
    });
  });
});

module.exports = router;
