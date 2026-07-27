ALTER TABLE "lobbies"
ADD COLUMN "pending_pattern_id" VARCHAR(128),
ADD COLUMN "pending_call_mode" "call_mode",
ADD COLUMN "pending_call_interval_seconds" SMALLINT;

UPDATE "lobbies" AS lobby
SET "pending_pattern_id" = 'standard-one-line',
    "pending_call_mode" = 'MANUAL',
    "pending_call_interval_seconds" = NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM "rounds" AS round
  WHERE round."lobby_id" = lobby."id"
);

UPDATE "command_results" AS command
SET "result" = command."result"
  || jsonb_build_object(
    'patternId', COALESCE(round."initial_pattern_id", 'standard-one-line'),
    'callConfiguration',
      CASE
        WHEN round."call_mode" = 'AUTOMATIC' THEN
          jsonb_build_object(
            'mode', 'automatic',
            'intervalSeconds', round."call_interval_seconds"
          )
        ELSE jsonb_build_object('mode', 'manual')
      END
  )
FROM "lobbies" AS lobby
LEFT JOIN "rounds" AS round ON round."lobby_id" = lobby."id"
WHERE command."lobby_id" = lobby."id"
  AND command."command_type" = 'create-lobby';

ALTER TABLE "lobbies"
ADD CONSTRAINT "lobbies_pending_call_configuration_check"
CHECK (
  (
    "pending_pattern_id" IS NULL
    AND "pending_call_mode" IS NULL
    AND "pending_call_interval_seconds" IS NULL
  )
  OR (
    "pending_pattern_id" IS NOT NULL
    AND (
      (
        "pending_call_mode" = 'MANUAL'
        AND "pending_call_interval_seconds" IS NULL
      )
      OR (
        "pending_call_mode" = 'AUTOMATIC'
        AND "pending_call_interval_seconds" IN (5, 10, 30, 60, 120)
      )
    )
  )
);
