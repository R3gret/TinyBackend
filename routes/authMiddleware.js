const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
  // Get token from header
  const authHeader = req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authorization token required (Bearer token)' 
    });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    // Assign the nested user object to req.user
    req.user =   decoded.user;

    // Critical Check: Ensure req.user exists and has an ID
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token: User information is missing.'
      });
    }

    next();
  } catch (error) {
    // More specific error messages
    let message = 'Invalid token';
    if (error.name === 'TokenExpiredError') {
      message = 'Token expired';
    } else if (error.name === 'JsonWebTokenError') {
      message = 'Malformed token';
    }
    
    return res.status(401).json({ 
      success: false, 
      message,
      error: error.name 
    });
  }
};

module.exports = authenticate;