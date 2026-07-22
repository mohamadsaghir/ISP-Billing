'use strict';

/**
 * Custom API Request Logger Middleware.
 * Logs method, route, status code, and response time.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  // Attach listener to response finish event
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, originalUrl } = req;
    const { statusCode } = res;

    // Color code status code for console readability
    let statusColor = '\x1b[32m'; // Green
    if (statusCode >= 400 && statusCode < 500) {
      statusColor = '\x1b[33m'; // Yellow
    } else if (statusCode >= 500) {
      statusColor = '\x1b[31m'; // Red
    }

    console.log(
      `[API] ${method} ${originalUrl} -> ${statusColor}${statusCode}\x1b[0m (${duration}ms)`
    );
  });

  next();
}

module.exports = requestLogger;
