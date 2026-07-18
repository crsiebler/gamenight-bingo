UPDATE "command_results"
   SET "result_format" = 2
 WHERE "result_format" = 3
   AND "round_id" IS NOT NULL
   AND "result_integrity" IS NULL;

ALTER TABLE "command_results"
    DROP CONSTRAINT "command_results_result_integrity_check",
    ADD CONSTRAINT "command_results_result_integrity_check" CHECK (
        ("result_format" IN (1, 2) AND "result_integrity" IS NULL)
        OR (
            "result_format" = 3
            AND (
                ("round_id" IS NULL AND "result_integrity" IS NULL)
                OR (
                    "round_id" IS NOT NULL
                    AND "result_integrity" IS NOT NULL
                    AND octet_length("result_integrity") = 32
                )
            )
        )
    );
