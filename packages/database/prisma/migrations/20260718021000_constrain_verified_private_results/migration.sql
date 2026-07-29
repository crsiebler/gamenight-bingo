ALTER TABLE "command_results"
    ADD CONSTRAINT "command_results_verified_private_scope_check" CHECK (
        "result_format" <> 3
        OR ("delivery_scope" = 'PARTICIPANT_PRIVATE' AND "event_sequence" IS NULL)
    );
