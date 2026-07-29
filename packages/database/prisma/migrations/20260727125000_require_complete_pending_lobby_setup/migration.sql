ALTER TABLE "lobbies"
DROP CONSTRAINT "lobbies_pending_call_configuration_check";

ALTER TABLE "lobbies"
ADD CONSTRAINT "lobbies_pending_call_configuration_check"
CHECK (
  (
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
  ) IS TRUE
);
