const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Import routes
const loginRoute = require('./routes/login');
const studentsRoute = require('./routes/students');
const studentRegistration = require('./routes/register');
const addActivities = require('./routes/add_activity');
const getActivities = require('./routes/get_activities');
const getScheduledDates = require('./routes/get_scheduled_dates');
const Attendance = require('./routes/attendance');
const usersRoute = require('./routes/users');
const accountRoute = require('./routes/account');
const userSession = require('./routes/user_session');
const domainsRoute = require('./routes/domains');
const fileRoutes = require('./routes/fileRoutes'); // Add this line to import the new file routes
const announcementsRouter = require('./routes/announcement');

// Use the routes
app.use('/api', loginRoute);
app.use('/api', studentsRoute);
app.use('/api', studentRegistration);
app.use('/api', addActivities);
app.use('/api', getActivities);
app.use('/api', getScheduledDates);
app.use('/api', Attendance);
app.use('/api', usersRoute);
app.use('/api/account', accountRoute);
app.use('/api/user_session', userSession);
app.use('/api/domains', domainsRoute);
app.use('/api/files', fileRoutes); // Add this line to use the file routes
app.use('/api/announcements', announcementsRouter);

app.use('/uploads/announcements', express.static(path.join(__dirname, 'uploads/announcements')));


// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});