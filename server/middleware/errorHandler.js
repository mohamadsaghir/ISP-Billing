'use strict';

/**
 * Centralized Express Error Handling Middleware.
 * Catches all errors thrown in routes, logs details, and returns structured JSON responses.
 */
function errorHandler(err, req, res, next) {
  // Determine status code (default to 500 Internal Server Error)
  const statusCode = err.status || err.statusCode || 500;
  
  // Log the full stack trace to the console
  console.error(`[Error] [${req.method}] ${req.originalUrl} - Status: ${statusCode}`);
  console.error(err.stack || err);

  // Return formatted JSON response
  res.status(statusCode).json({
    success: false,
    message: err.userMessage || 'حدث خطأ داخلي في الخادم، يرجى المحاولة لاحقاً',
    error: process.env.NODE_ENV === 'development' ? {
      name: err.name,
      message: err.message,
      stack: err.stack
    } : undefined
  });
}

module.exports = errorHandler;
