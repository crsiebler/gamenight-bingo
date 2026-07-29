ALTER TABLE "command_results"
    ADD COLUMN "result_integrity" BYTEA,
    DROP CONSTRAINT "command_results_result_format_check",
    ADD CONSTRAINT "command_results_result_format_check" CHECK ("result_format" IN (1, 2, 3)),
    ADD CONSTRAINT "command_results_result_integrity_check" CHECK (
        ("result_format" IN (1, 2) AND "result_integrity" IS NULL)
        OR (
            "result_format" = 3
            AND (
                ("round_id" IS NULL AND "result_integrity" IS NULL)
                OR ("round_id" IS NOT NULL AND octet_length("result_integrity") = 32)
            )
        )
    );
