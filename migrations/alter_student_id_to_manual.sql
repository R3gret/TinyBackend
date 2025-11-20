-- Migration: Change student_id from AUTO_INCREMENT INT to manual VARCHAR
-- This allows manual input of student IDs in format YYYY-MM-DD (e.g., 2025-01-01)
-- Run this script to update the students table structure

-- Step 1: Drop foreign key constraints that reference student_id
ALTER TABLE `activity_submissions` DROP FOREIGN KEY `activity_submissions_ibfk_2`;
ALTER TABLE `attendance` DROP FOREIGN KEY `attendance_ibfk_1`;
ALTER TABLE `child_other_info` DROP FOREIGN KEY `fk_student_id`;
ALTER TABLE `emergency_info` DROP FOREIGN KEY `emergency_info_ibfk_1`;
ALTER TABLE `evaluations` DROP FOREIGN KEY `evaluations_ibfk_1`;
ALTER TABLE `father_info` DROP FOREIGN KEY `father_info_ibfk_1`;
ALTER TABLE `guardian_info` DROP FOREIGN KEY `guardian_info_ibfk_1`;
ALTER TABLE `mother_info` DROP FOREIGN KEY `mother_info_ibfk_1`;

-- Step 2: Drop the primary key constraint
ALTER TABLE `students` DROP PRIMARY KEY;

-- Step 3: Change student_id column from INT to VARCHAR
ALTER TABLE `students` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL;

-- Step 4: Re-add primary key constraint
ALTER TABLE `students` 
  ADD PRIMARY KEY (`student_id`);

-- Step 5: Re-add foreign key constraints with updated column types
ALTER TABLE `activity_submissions` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `activity_submissions_ibfk_2` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE;

ALTER TABLE `attendance` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `attendance_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`);

ALTER TABLE `child_other_info` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `fk_student_id` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `emergency_info` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `emergency_info_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `evaluations` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `evaluations_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`);

ALTER TABLE `father_info` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `father_info_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `guardian_info` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `guardian_info_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `mother_info` 
  MODIFY COLUMN `student_id` VARCHAR(50) NOT NULL,
  ADD CONSTRAINT `mother_info_ibfk_1` 
    FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: After running this migration, student_id will be VARCHAR(50) and must be manually provided during registration
-- Format: YYYY-MM-DD (e.g., 2025-01-01)

