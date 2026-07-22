ALTER TABLE "command_results"
    ADD COLUMN "result_format" SMALLINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT "command_results_result_format_check" CHECK ("result_format" IN (1, 2));
