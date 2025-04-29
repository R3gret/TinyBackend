const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/get_scheduled_dates?year=YYYY&month=MM
router.get('/', async (req, res) => {
    const { year, month } = req.query;
    let connection;

    console.log(`Fetching scheduled dates for ${year}-${month}`);

    const query = `
      SELECT DISTINCT DATE_FORMAT(wp.date, '%Y-%m-%d') AS date 
      FROM weekly_plans wp
      JOIN scheduled_activity sa ON wp.plan_id = sa.plan_id
      WHERE YEAR(wp.date) = ? AND MONTH(wp.date) = ?
    `;

    try {
        connection = await db.promisePool.getConnection();
        const [results] = await connection.query(query, [year, month]);

        const dates = results.map(row => row.date);
        console.log('Scheduled dates:', dates);
        res.json({ success: true, dates });
    } catch (err) {
        console.error('Error fetching scheduled dates:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch scheduled dates' 
        });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;