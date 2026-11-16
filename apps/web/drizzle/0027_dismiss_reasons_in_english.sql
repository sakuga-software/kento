-- REV-114. Kentō is in English. The reasons that the dialog offered in French, and the reason of a
-- 👎, get their English value: the Findings screen counts each reason once, and the model reads
-- English. A reason that a person wrote (« Other ») does not change.
UPDATE "findings" SET "status_reason" = CASE "status_reason"
  WHEN 'Faux positif' THEN 'False positive'
  WHEN 'Hors sujet' THEN 'Off topic'
  WHEN 'Déjà connu' THEN 'Already known'
  WHEN 'Style, pas un défaut' THEN 'Style, not a defect'
  WHEN 'sans motif, réaction GitHub' THEN 'no reason, GitHub reaction'
END
WHERE "status_reason" IN ('Faux positif', 'Hors sujet', 'Déjà connu', 'Style, pas un défaut', 'sans motif, réaction GitHub');--> statement-breakpoint
UPDATE "finding_events" SET "reason" = CASE "reason"
  WHEN 'Faux positif' THEN 'False positive'
  WHEN 'Hors sujet' THEN 'Off topic'
  WHEN 'Déjà connu' THEN 'Already known'
  WHEN 'Style, pas un défaut' THEN 'Style, not a defect'
  WHEN 'sans motif, réaction GitHub' THEN 'no reason, GitHub reaction'
END
WHERE "reason" IN ('Faux positif', 'Hors sujet', 'Déjà connu', 'Style, pas un défaut', 'sans motif, réaction GitHub');
