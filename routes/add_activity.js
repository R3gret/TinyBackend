const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/add_activity', (req, res) => {
  const { date, activities } = req.body;

  if (!date || !Array.isArray(activities) || activities.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Step 1: Check if a plan already exists for the given date
  db.query('SELECT plan_id FROM weekly_plans WHERE date = ?', [date], (err, planResults) => {
    if (err) {
      console.error('Error checking existing plan:', err);
      return res.status(500).json({ error: 'Database error checking plan' });
    }

    let planId;

    const insertActivities = (planIdToUse) => {
      // Step 2: Check existing activities for duplicates
      db.query(
        'SELECT activity_name, start_time, end_time FROM scheduled_activity WHERE plan_id = ?',
        [planIdToUse],
        (err, existingActivities) => {
          if (err) {
            console.error('Error fetching existing activities:', err);
            return res.status(500).json({ error: 'Database error checking activities' });
          }

          const newActivities = activities.filter(newAct => {
            return !existingActivities.some(existingAct =>
              existingAct.activity_name === newAct.activity_name &&
              existingAct.start_time === newAct.start_time &&
              existingAct.end_time === newAct.end_time
            );
          });

          if (newActivities.length === 0) {
            return res.json({
              success: true,
              message: 'No new activities to add (duplicates skipped)'
            });
          }

          const values = newActivities.map(act => [
            planIdToUse,
            act.activity_name,
            act.start_time,
            act.end_time
          ]);

          db.query(
            `INSERT INTO scheduled_activity (plan_id, activity_name, start_time, end_time) VALUES ?`,
            [values],
            (err, result) => {
              if (err) {
                console.error('Error inserting new activities:', err);
                return res.status(500).json({ error: 'Database error inserting activities' });
              }

              return res.json({
                success: true,
                message: `${result.affectedRows} activities added successfully`,
                insertedCount: result.affectedRows,
                skippedCount: activities.length - newActivities.length
              });
            }
          );
        }
      );
    };

    if (planResults.length > 0) {
      planId = planResults[0].plan_id;
      insertActivities(planId);
    } else {
      // Step 3: If no plan exists, insert a new plan
      db.query('INSERT INTO weekly_plans (date) VALUES (?)', [date], (err, insertResult) => {
        if (err) {
          console.error('Error inserting new plan:', err);
          return res.status(500).json({ error: 'Database error creating plan' });
        }

        planId = insertResult.insertId;
        insertActivities(planId);
      });
    }
  });
});

module.exports = router;
