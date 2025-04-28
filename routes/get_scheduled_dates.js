// routes/activities.js
const express = require('express');
const router = express.Router();
const db = require('../db'); // MySQL connection

// GET /api/get_scheduled_dates?year=YYYY&month=MM
router.get('/get_scheduled_dates', (req, res) => {
    const { year, month } = req.query;
  
    console.log(`Fetching scheduled dates for ${year}-${month}`);
  
    const query = `
      SELECT DISTINCT DATE_FORMAT(wp.date, '%Y-%m-%d') AS date 
      FROM weekly_plans wp
      JOIN scheduled_activity sa ON wp.plan_id = sa.plan_id
      WHERE YEAR(wp.date) = ? AND MONTH(wp.date) = ?
    `;
  
    db.query(query, [year, month], (err, results) => {
      if (err) {
        console.error('Error fetching scheduled dates:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch scheduled dates' });
      }
  
      const dates = results.map(row => row.date); // Correct local dates now
      console.log('Scheduled dates:', dates);
      res.json({ success: true, dates });
    });
  });

module.exports = router;
