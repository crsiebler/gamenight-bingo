ALTER TABLE "command_results"
    DROP CONSTRAINT "command_results_result_format_check",
    ADD CONSTRAINT "command_results_result_format_check" CHECK ("result_format" IN (1, 2, 3, 4)),
    DROP CONSTRAINT "command_results_verified_private_scope_check",
    ADD CONSTRAINT "command_results_verified_delivery_scope_check" CHECK (
        ("result_format" <> 3 OR ("delivery_scope" = 'PARTICIPANT_PRIVATE' AND "event_sequence" IS NULL))
        AND ("result_format" <> 4 OR ("delivery_scope" = 'ACTIVE_LOBBY' AND "event_sequence" IS NOT NULL))
    ),
    DROP CONSTRAINT "command_results_result_integrity_check",
    ADD CONSTRAINT "command_results_result_integrity_check" CHECK (
        ("result_format" IN (1, 2) AND "result_integrity" IS NULL)
        OR (
            "result_format" IN (3, 4)
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
