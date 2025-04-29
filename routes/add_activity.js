const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/add_activity', async (req, res) => {
  const { date, activities } = req.body;
  let connection;

  // Input validation
  if (!date || !Array.isArray(activities) || activities.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    connection = await db.promisePool.getConnection();
    await connection.beginTransaction();

    // Step 1: Check if a plan already exists for the given date
    const [planResults] = await connection.query(
      'SELECT plan_id FROM weekly_plans WHERE date_of_week = ?', 
      [date]
    );

    let planId;

    if (planResults.length > 0) {
      planId = planResults[0].plan_id;
    } else {
      // Step 2: If no plan exists, insert a new plan
      const [insertResult] = await connection.query(
        'INSERT INTO weekly_plans (date_of_week) VALUES (?)', 
        [date]
      );
      planId = insertResult.insertId;
    }

    // Step 3: Check existing activities for duplicates
    const [existingActivities] = await connection.query(
      'SELECT activity_name, start_time, end_time FROM scheduled_activity WHERE plan_id = ?',
      [planId]
    );

    const newActivities = activities.filter(newAct => {
      return !existingActivities.some(existingAct =>
        existingAct.activity_name === newAct.activity_name &&
        existingAct.start_time === newAct.start_time &&
        existingAct.end_time === newAct.end_time
      );
    });

    if (newActivities.length === 0) {
      await connection.commit();
      return res.json({
        success: true,
        message: 'No new activities to add (duplicates skipped)'
      });
    }

    // Step 4: Insert new activities
    const values = newActivities.map(act => [
      planId,
      act.activity_name,
      act.start_time,
      act.end_time
    ]);

    const [result] = await connection.query(
      `INSERT INTO scheduled_activity (plan_id, activity_name, start_time, end_time) VALUES ?`,
      [values]
    );

    await connection.commit();
    
    res.json({
      success: true,
      message: `${result.affectedRows} activities added successfully`,
      insertedCount: result.affectedRows,
      skippedCount: activities.length - newActivities.length
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Database error:', err);
    res.status(500).json({ 
      error: 'Database operation failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;