const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
    const { year, month } = req.query;
    let connection;

    // Input validation
    if (!year || !month || isNaN(year) || isNaN(month)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Year and month parameters are required and must be numbers' 
        });
    }

    console.log(`Fetching scheduled dates for ${year}-${month}`);

    try {
        connection = await db.promisePool.getConnection();
        
        // First verify the connection
        await connection.ping();
        
        const query = `
          SELECT DISTINCT DATE_FORMAT(wp.date, '%Y-%m-%d') AS date 
          FROM weekly_plans wp
          JOIN scheduled_activity sa ON wp.plan_id = sa.plan_id
          WHERE YEAR(wp.date) = ? AND MONTH(wp.date) = ?
        `;

        const [results] = await connection.query(query, [year, month]);

        const dates = results.map(row => row.date);
        console.log('Scheduled dates:', dates);
        res.json({ success: true, dates });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Database error while fetching scheduled dates',
            error: err.message // Include more error details
        });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;