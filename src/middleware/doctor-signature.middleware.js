const { verifyDoctorSignature } = require('../services/integrations/doctor-profile.service');

function requireDoctorSignature(req, _res, next) {
  try {
    verifyDoctorSignature(req);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireDoctorSignature };
