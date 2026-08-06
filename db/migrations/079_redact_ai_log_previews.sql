-- AI log previews may contain chat, symptom, or location-related content.
-- Keep operational/token metadata, but remove already persisted free text.

UPDATE ai_logs
   SET prompt_summary = CASE WHEN prompt_summary IS NULL THEN NULL ELSE '[redacted]' END,
       response_summary = CASE WHEN response_summary IS NULL THEN NULL ELSE '[redacted]' END
 WHERE prompt_summary IS NOT NULL
    OR response_summary IS NOT NULL;
