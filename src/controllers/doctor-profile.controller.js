const { loadPatientProfile } = require('../services/integrations/doctor-profile.service');

const getDoctorPatientProfile = async (pool, req, res) => {
  const profile = await loadPatientProfile(pool, req);
  return res.status(200).json({ ok: true, data: profile });
};

module.exports = { getDoctorPatientProfile };
