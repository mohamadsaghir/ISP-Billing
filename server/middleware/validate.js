'use strict';

const { validationResult } = require('express-validator');

/**
 * Collect express-validator errors and return 422 if any
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'بيانات غير صالحة',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

module.exports = { validate };
