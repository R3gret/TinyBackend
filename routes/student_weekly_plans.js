const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('./authMiddleware');

// Create a new student weekly plan with activities
router.post('/', authenticate, async (req, res) => {
    const { plan_date, activities } = req.body;
    const cdcId = req.user.cdc_id;

    if (!plan_date || !activities || !Array.isArray(activities)) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const connection = await db.promisePool.getConnection();
    try {
        await connection.beginTransaction();

        // Insert into student_weekly_plans
        const [planResult] = await connection.query(
            'INSERT INTO student_weekly_plans (plan_date, cdc_id) VALUES (?, ?)',
            [plan_date, cdcId]
        );
        const student_plan_id = planResult.insertId;

        // Insert into student_scheduled_activities
        if (activities.length > 0) {
            const activityValues = activities.map(act => [student_plan_id, act.activity_name, act.start_time, act.end_time]);
            await connection.query(
                'INSERT INTO student_scheduled_activities (student_plan_id, activity_name, start_time, end_time) VALUES ?',
                [activityValues]
            );
        }

        await connection.commit();
        res.status(201).json({
            success: true,
            message: 'Student weekly plan created successfully.',
            student_plan_id
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error creating student weekly plan:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    } finally {
        connection.release();
    }
});

// Get all weekly plans for the user's CDC (without activities)
router.get('/', authenticate, async (req, res) => {
    const cdcId = req.user.cdc_id;

    const connection = await db.promisePool.getConnection();
    try {
        const [plans] = await connection.query(
            `SELECT p.student_plan_id, p.plan_date
             FROM student_weekly_plans p
             WHERE p.cdc_id = ?
             ORDER BY p.plan_date DESC`,
            [cdcId]
        );

        res.json({ success: true, plans: plans });
    } catch (error) {
        console.error('Error fetching student weekly plans:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    } finally {
        connection.release();
    }
});

// Get scheduled dates
router.get('/dates', authenticate, async (req, res) => {
    const { year, month } = req.query;
    const { cdc_id } = req.user;
    let connection;

    if (!cdc_id) {
        return res.status(403).json({ success: false, message: 'User is not associated with a CDC.' });
    }
    if (!year || !month || isNaN(year) || isNaN(month)) {
        return res.status(400).json({
            success: false,
            message: 'Year and month parameters are required and must be numbers'
        });
    }

    console.log(`Fetching scheduled dates for ${year}-${month} for cdc_id: ${cdc_id}`);

    try {
        connection = await db.promisePool.getConnection();

        const query = `
          SELECT DISTINCT DATE_FORMAT(swp.plan_date, '%Y-%m-%d') AS date
          FROM student_weekly_plans swp
          JOIN student_scheduled_activities ssa ON swp.student_plan_id = ssa.student_plan_id
          WHERE YEAR(swp.plan_date) = ? AND MONTH(swp.plan_date) = ? AND swp.cdc_id = ?
        `;

        const [results] = await connection.query(query, [year, month, cdc_id]);

        const dates = results.map(row => row.date);
        console.log('Scheduled dates:', dates);
        res.json({ success: true, dates });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({
            success: false,
            message: 'Database error while fetching scheduled dates',
            error: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// Get activities for a specific date
router.get('/activities', authenticate, async (req, res) => {
  const { date } = req.query;
  const { cdc_id } = req.user;
  let connection;

  if (!cdc_id) {
    return res.status(403).json({ success: false, message: 'User is not associated with a CDC.' });
  }
  if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return res.status(400).json({
      success: false,
      message: 'Date parameter is required in YYYY-MM-DD format'
    });
  }

  console.log(`Fetching activities for date: ${date} and cdc_id: ${cdc_id}`);

  try {
    connection = await db.promisePool.getConnection();

    const query = `
      SELECT ssa.*
      FROM student_scheduled_activities ssa
      JOIN student_weekly_plans swp ON ssa.student_plan_id = swp.student_plan_id
      WHERE DATE(swp.plan_date) = ? AND swp.cdc_id = ?
    `;

    const [results] = await connection.query(query, [date, cdc_id]);

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