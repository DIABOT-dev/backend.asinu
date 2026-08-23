const { t, getLang } = require('../i18n');
const { doctorTaskRequestSchema } = require('../services/integrations/doctor-task.policy');
const { enqueueDoctorTask } = require('../services/integrations/doctor-task.service');

const loadPatientProjection = async (pool, userId) => {
  const result = await pool.query(
    `SELECT u.id, u.full_name, u.display_name, u.consent_accepted_at, u.consent_version,
            u.updated_at AS profile_version, p.age AS age_group, p.gender
       FROM users u
       LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId]
  );
  return result.rows[0] || null;
};

const requestDoctorTask = async (pool, req, res) => {
  const parsed = doctorTaskRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('error.invalid_data', getLang(req)),
      details: parsed.error.issues,
    });
  }

  const patient = await loadPatientProjection(pool, req.user.id);
  if (!patient) return res.status(404).json({ ok: false, error: 'Patient not found.' });
  if (!patient.consent_accepted_at || patient.consent_version !== parsed.data.consent_version) {
    return res.status(403).json({ ok: false, error: 'Doctor consultation consent is required.' });
  }

  const result = await enqueueDoctorTask(pool, { user: patient, input: parsed.data });
  return res.status(202).json({ ok: true, data: result });
};

module.exports = { requestDoctorTask };
