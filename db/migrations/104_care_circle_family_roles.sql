-- Care Circle stores only family roles. Do not reclassify professional roles
-- as relatives: remove their role value instead. Existing consent is independent.
WITH normalized AS (
  SELECT id,
    CASE LOWER(BTRIM(NORMALIZE(role, NFC)))
      WHEN 'than-nhan' THEN 'than-nhan'
      WHEN 'thân nhân' THEN 'than-nhan'
      WHEN 'người thân' THEN 'than-nhan'
      WHEN 'gia đình' THEN 'than-nhan'
      WHEN 'relative' THEN 'than-nhan'
      WHEN 'family member' THEN 'than-nhan'
      WHEN 'family' THEN 'than-nhan'
      WHEN 'nguoi-cham-soc' THEN 'nguoi-cham-soc'
      WHEN 'người chăm sóc' THEN 'nguoi-cham-soc'
      WHEN 'người chăm sóc chính' THEN 'nguoi-cham-soc'
      WHEN 'người thân chăm sóc chính' THEN 'nguoi-cham-soc'
      WHEN 'primary caregiver' THEN 'nguoi-cham-soc'
      WHEN 'family caregiver' THEN 'nguoi-cham-soc'
      WHEN 'caregiver' THEN 'nguoi-cham-soc'
      ELSE NULL
    END AS family_role
  FROM user_connections
)
UPDATE user_connections AS connection
SET role = normalized.family_role
FROM normalized
WHERE connection.id = normalized.id
  AND connection.role IS DISTINCT FROM normalized.family_role;

ALTER TABLE user_connections
  ADD CONSTRAINT user_connections_family_role_check
  CHECK (role IS NULL OR role IN ('than-nhan', 'nguoi-cham-soc'));

COMMENT ON COLUMN user_connections.role IS
  'Optional family role: than-nhan or nguoi-cham-soc; not a professional or clinical role';
