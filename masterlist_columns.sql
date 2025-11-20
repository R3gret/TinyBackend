-- Adds the columns required for the daycare master list export.
-- Run this script after importing `u232175931_tinytrack_db (2).sql`.

ALTER TABLE `students`
  ADD COLUMN `four_ps_id` varchar(50) DEFAULT NULL AFTER `gender`,
  ADD COLUMN `disability` varchar(10) DEFAULT NULL AFTER `four_ps_id`,
  ADD COLUMN `height_cm` decimal(5,2) DEFAULT NULL AFTER `disability`,
  ADD COLUMN `weight_kg` decimal(5,2) DEFAULT NULL AFTER `height_cm`,
  ADD COLUMN `birthplace` varchar(255) DEFAULT NULL AFTER `weight_kg`;


