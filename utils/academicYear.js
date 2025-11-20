// Helper function to parse academic year and get date range
// Academic year format: "YYYY-YYYY+1" (e.g., "2025-2026")
// Academic year spans 10 months: June of first year to March of second year
const getAcademicYearDateRange = (academicYear) => {
  if (!academicYear || typeof academicYear !== 'string') {
    return null;
  }
  
  // Parse "YYYY-YYYY+1" format (e.g., "2025-2026")
  const match = academicYear.match(/^(\d{4})-(\d{4})$/);
  if (!match) {
    return null;
  }
  
  const startYear = parseInt(match[1], 10);
  const endYear = parseInt(match[2], 10);
  
  // Validate that endYear is startYear + 1
  if (endYear !== startYear + 1) {
    return null;
  }
  
  // Academic year runs from June (month 6) of startYear to March (month 3) of endYear
  // This is 10 months: Jun, Jul, Aug, Sep, Oct, Nov, Dec (startYear), Jan, Feb, Mar (endYear)
  const startDate = new Date(startYear, 5, 1); // June 1 of startYear (month is 0-indexed, so 5 = June)
  const endDate = new Date(endYear, 2, 31); // March 31 of endYear (month is 0-indexed, so 2 = March)
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
};

module.exports = { getAcademicYearDateRange };

