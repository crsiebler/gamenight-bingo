-- CreateEnum
CREATE TYPE "lobby_status" AS ENUM ('WAITING', 'ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "participant_role" AS ENUM ('HOST', 'PLAYER');

-- CreateEnum
CREATE TYPE "round_eligibility" AS ENUM ('PLAYING', 'WAITING');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('ACTIVE', 'DISCONNECTED', 'DEPARTED');

-- CreateEnum
CREATE TYPE "presence_status" AS ENUM ('CONNECTED', 'GRACE', 'ABSENT', 'DEPARTED');

-- CreateEnum
CREATE TYPE "round_stage" AS ENUM ('WAITING', 'ACTIVE', 'PAUSED', 'CO_WINNER_WINDOW', 'RESULT', 'ENDED');

-- CreateEnum
CREATE TYPE "call_mode" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "pause_reason" AS ENUM ('HOST_COMMAND', 'HOST_ABSENT', 'PARTICIPANT_ABSENT');

-- CreateEnum
CREATE TYPE "delivery_scope" AS ENUM ('ACTIVE_LOBBY', 'PARTICIPANT_PRIVATE');

-- CreateTable
CREATE TABLE "lobbies" (
    "id" VARCHAR(128) NOT NULL,
    "code" CHAR(6) NOT NULL,
    "status" "lobby_status" NOT NULL,
    "theme_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "last_event_sequence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "lobbies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" VARCHAR(128) NOT NULL,
    "lobby_id" VARCHAR(128) NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "normalized_username" VARCHAR(128) NOT NULL,
    "role" "participant_role" NOT NULL,
    "round_eligibility" "round_eligibility" NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "departed_at" TIMESTAMPTZ(3),

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participant_sessions" (
    "id" VARCHAR(128) NOT NULL,
    "lobby_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "status" "session_status" NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3),
    "rejoin_until" TIMESTAMPTZ(3),
    "departed_at" TIMESTAMPTZ(3),

    CONSTRAINT "participant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presence_generations" (
    "lobby_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "generation" BIGINT NOT NULL,
    "status" "presence_status" NOT NULL,
    "connection_count" SMALLINT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "grace_ends_at" TIMESTAMPTZ(3),
    "absent_since" TIMESTAMPTZ(3),
    "departed_at" TIMESTAMPTZ(3),
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "presence_generations_pkey" PRIMARY KEY ("participant_id","generation")
);

-- CreateTable
CREATE TABLE "rounds" (
    "id" VARCHAR(128) NOT NULL,
    "lobby_id" VARCHAR(128) NOT NULL,
    "initial_pattern_id" VARCHAR(128) NOT NULL,
    "current_pattern_id" VARCHAR(128) NOT NULL,
    "stage" "round_stage" NOT NULL,
    "call_mode" "call_mode" NOT NULL,
    "call_interval_seconds" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "active_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "pause_reason" "pause_reason",
    "next_call_at" TIMESTAMPTZ(3),
    "co_winner_triggering_call_id" VARCHAR(128),
    "co_winner_opened_at" TIMESTAMPTZ(3),
    "co_winner_closes_at" TIMESTAMPTZ(3),
    "result_settled_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draw_positions" (
    "round_id" VARCHAR(128) NOT NULL,
    "position" SMALLINT NOT NULL,
    "ball" SMALLINT NOT NULL,

    CONSTRAINT "draw_positions_pkey" PRIMARY KEY ("round_id","position")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" VARCHAR(128) NOT NULL,
    "lobby_id" VARCHAR(128) NOT NULL,
    "round_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "cells" INTEGER[] NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" VARCHAR(128) NOT NULL,
    "round_id" VARCHAR(128) NOT NULL,
    "position" SMALLINT NOT NULL,
    "ball" SMALLINT NOT NULL,
    "called_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marks" (
    "id" VARCHAR(128) NOT NULL,
    "round_id" VARCHAR(128) NOT NULL,
    "card_id" VARCHAR(128) NOT NULL,
    "ball" SMALLINT NOT NULL,
    "marked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "co_winners" (
    "lobby_id" VARCHAR(128) NOT NULL,
    "round_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "card_id" VARCHAR(128) NOT NULL,
    "triggering_call_id" VARCHAR(128) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "co_winners_pkey" PRIMARY KEY ("round_id","participant_id")
);

-- CreateTable
CREATE TABLE "active_lobby_events" (
    "lobby_id" VARCHAR(128) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "round_id" VARCHAR(128),
    "event_type" VARCHAR(64) NOT NULL,
    "schema_version" SMALLINT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "active_lobby_events_pkey" PRIMARY KEY ("lobby_id","sequence")
);

-- CreateTable
CREATE TABLE "command_results" (
    "lobby_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "command_id" VARCHAR(128) NOT NULL,
    "round_id" VARCHAR(128),
    "command_type" VARCHAR(64) NOT NULL,
    "delivery_scope" "delivery_scope" NOT NULL,
    "event_sequence" BIGINT,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "command_results_pkey" PRIMARY KEY ("lobby_id","participant_id","command_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "participants_lobby_username_key" ON "participants"("lobby_id", "normalized_username");

-- CreateIndex
CREATE UNIQUE INDEX "participants_lobby_id_id_key" ON "participants"("lobby_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "participant_sessions_token_hash_key" ON "participant_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_lobby_id_key" ON "rounds"("lobby_id");

-- CreateIndex
CREATE UNIQUE INDEX "draw_positions_round_ball_key" ON "draw_positions"("round_id", "ball");

-- CreateIndex
CREATE UNIQUE INDEX "draw_positions_round_position_ball_key" ON "draw_positions"("round_id", "position", "ball");

-- CreateIndex
CREATE UNIQUE INDEX "cards_round_participant_key" ON "cards"("round_id", "participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cards_id_round_key" ON "cards"("id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_round_position_key" ON "calls"("round_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "calls_round_ball_key" ON "calls"("round_id", "ball");

-- CreateIndex
CREATE UNIQUE INDEX "marks_card_ball_key" ON "marks"("card_id", "ball");

-- CreateIndex
CREATE UNIQUE INDEX "co_winners_round_card_key" ON "co_winners"("round_id", "card_id");

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participant_sessions" ADD CONSTRAINT "participant_sessions_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participant_sessions" ADD CONSTRAINT "participant_sessions_lobby_id_participant_id_fkey" FOREIGN KEY ("lobby_id", "participant_id") REFERENCES "participants"("lobby_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presence_generations" ADD CONSTRAINT "presence_generations_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presence_generations" ADD CONSTRAINT "presence_generations_lobby_id_participant_id_fkey" FOREIGN KEY ("lobby_id", "participant_id") REFERENCES "participants"("lobby_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_positions" ADD CONSTRAINT "draw_positions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_lobby_id_participant_id_fkey" FOREIGN KEY ("lobby_id", "participant_id") REFERENCES "participants"("lobby_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_card_id_round_id_fkey" FOREIGN KEY ("card_id", "round_id") REFERENCES "cards"("id", "round_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "co_winners" ADD CONSTRAINT "co_winners_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_lobby_events" ADD CONSTRAINT "active_lobby_events_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_lobby_events" ADD CONSTRAINT "active_lobby_events_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_results" ADD CONSTRAINT "command_results_lobby_id_fkey" FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_results" ADD CONSTRAINT "command_results_lobby_id_participant_id_fkey" FOREIGN KEY ("lobby_id", "participant_id") REFERENCES "participants"("lobby_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_results" ADD CONSTRAINT "command_results_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL constraints not expressible in the Prisma schema language.
CREATE UNIQUE INDEX "lobbies_active_code_key"
    ON "lobbies" ("code")
    WHERE "status" IN ('WAITING', 'ACTIVE');

CREATE UNIQUE INDEX "participants_one_host_per_lobby_key"
    ON "participants" ("lobby_id")
    WHERE "role" = 'HOST';

CREATE UNIQUE INDEX "presence_generations_current_key"
    ON "presence_generations" ("participant_id")
    WHERE "ended_at" IS NULL;

CREATE UNIQUE INDEX "cards_round_cells_key" ON "cards" ("round_id", "cells");
CREATE UNIQUE INDEX "cards_id_round_participant_key"
    ON "cards" ("id", "round_id", "participant_id");
CREATE UNIQUE INDEX "rounds_id_lobby_key" ON "rounds" ("id", "lobby_id");
CREATE UNIQUE INDEX "calls_id_round_key" ON "calls" ("id", "round_id");

ALTER TABLE "lobbies"
    ADD CONSTRAINT "lobbies_code_format_check"
        CHECK ("code" ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
    ADD CONSTRAINT "lobbies_event_sequence_check"
        CHECK ("last_event_sequence" >= 0),
    ADD CONSTRAINT "lobbies_activity_time_check"
        CHECK ("last_activity_at" >= "created_at"),
    ADD CONSTRAINT "lobbies_ended_time_check"
        CHECK ("ended_at" IS NULL OR "ended_at" >= "created_at");

ALTER TABLE "participant_sessions"
    ADD CONSTRAINT "participant_sessions_hash_length_check"
        CHECK (octet_length("token_hash") = 32),
    ADD CONSTRAINT "participant_sessions_status_time_check"
        CHECK ((
          ("status" = 'ACTIVE' AND "disconnected_at" IS NULL AND "rejoin_until" IS NULL AND "departed_at" IS NULL)
          OR ("status" = 'DISCONNECTED' AND "disconnected_at" IS NOT NULL AND "rejoin_until" > "disconnected_at" AND "departed_at" IS NULL)
          OR ("status" = 'DEPARTED' AND "departed_at" IS NOT NULL)
        ) IS TRUE);

ALTER TABLE "presence_generations"
    ADD CONSTRAINT "presence_generations_generation_check" CHECK ("generation" > 0),
    ADD CONSTRAINT "presence_generations_connection_count_check" CHECK ("connection_count" >= 0),
    ADD CONSTRAINT "presence_generations_status_check"
        CHECK ((
          ("status" = 'CONNECTED' AND "connection_count" > 0 AND "grace_ends_at" IS NULL AND "absent_since" IS NULL AND "departed_at" IS NULL)
          OR ("status" = 'GRACE' AND "connection_count" = 0 AND "grace_ends_at" > "changed_at" AND "absent_since" IS NULL AND "departed_at" IS NULL)
          OR ("status" = 'ABSENT' AND "connection_count" = 0 AND "grace_ends_at" IS NULL AND "absent_since" IS NOT NULL AND "departed_at" IS NULL)
          OR ("status" = 'DEPARTED' AND "connection_count" = 0 AND "grace_ends_at" IS NULL AND "departed_at" IS NOT NULL)
        ) IS TRUE);

ALTER TABLE "rounds"
    ADD CONSTRAINT "rounds_call_configuration_check"
        CHECK ((
          ("call_mode" = 'MANUAL' AND "call_interval_seconds" IS NULL)
          OR ("call_mode" = 'AUTOMATIC' AND "call_interval_seconds" IN (5, 10, 30, 60, 120))
        ) IS TRUE),
    ADD CONSTRAINT "rounds_co_winner_window_check"
        CHECK ((
          ("co_winner_opened_at" IS NULL AND "co_winner_closes_at" IS NULL)
          OR ("co_winner_opened_at" IS NOT NULL AND "co_winner_closes_at" > "co_winner_opened_at")
        ) IS TRUE);

ALTER TABLE "draw_positions"
    ADD CONSTRAINT "draw_positions_position_check" CHECK ("position" BETWEEN 1 AND 75),
    ADD CONSTRAINT "draw_positions_ball_check" CHECK ("ball" BETWEEN 1 AND 75);

CREATE FUNCTION "is_valid_bingo_card"("values" INTEGER[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT cardinality("values") = 25
    AND "values"[13] = 0
    AND (SELECT count(DISTINCT value) = 5 FROM unnest(ARRAY["values"[1], "values"[6], "values"[11], "values"[16], "values"[21]]) value)
    AND (SELECT count(DISTINCT value) = 5 FROM unnest(ARRAY["values"[2], "values"[7], "values"[12], "values"[17], "values"[22]]) value)
    AND (SELECT count(DISTINCT value) = 4 FROM unnest(ARRAY["values"[3], "values"[8], "values"[18], "values"[23]]) value)
    AND (SELECT count(DISTINCT value) = 5 FROM unnest(ARRAY["values"[4], "values"[9], "values"[14], "values"[19], "values"[24]]) value)
    AND (SELECT count(DISTINCT value) = 5 FROM unnest(ARRAY["values"[5], "values"[10], "values"[15], "values"[20], "values"[25]]) value)
    AND "values"[1] BETWEEN 1 AND 15 AND "values"[6] BETWEEN 1 AND 15 AND "values"[11] BETWEEN 1 AND 15 AND "values"[16] BETWEEN 1 AND 15 AND "values"[21] BETWEEN 1 AND 15
    AND "values"[2] BETWEEN 16 AND 30 AND "values"[7] BETWEEN 16 AND 30 AND "values"[12] BETWEEN 16 AND 30 AND "values"[17] BETWEEN 16 AND 30 AND "values"[22] BETWEEN 16 AND 30
    AND "values"[3] BETWEEN 31 AND 45 AND "values"[8] BETWEEN 31 AND 45 AND "values"[18] BETWEEN 31 AND 45 AND "values"[23] BETWEEN 31 AND 45
    AND "values"[4] BETWEEN 46 AND 60 AND "values"[9] BETWEEN 46 AND 60 AND "values"[14] BETWEEN 46 AND 60 AND "values"[19] BETWEEN 46 AND 60 AND "values"[24] BETWEEN 46 AND 60
    AND "values"[5] BETWEEN 61 AND 75 AND "values"[10] BETWEEN 61 AND 75 AND "values"[15] BETWEEN 61 AND 75 AND "values"[20] BETWEEN 61 AND 75 AND "values"[25] BETWEEN 61 AND 75;
$$;

ALTER TABLE "cards"
    ADD CONSTRAINT "cards_cells_check" CHECK ("is_valid_bingo_card"("cells") IS TRUE),
    ADD CONSTRAINT "cards_round_lobby_fkey"
        FOREIGN KEY ("round_id", "lobby_id")
        REFERENCES "rounds" ("id", "lobby_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calls"
    ADD CONSTRAINT "calls_position_check" CHECK ("position" BETWEEN 1 AND 75),
    ADD CONSTRAINT "calls_ball_check" CHECK ("ball" BETWEEN 1 AND 75),
    ADD CONSTRAINT "calls_draw_position_fkey"
        FOREIGN KEY ("round_id", "position", "ball")
        REFERENCES "draw_positions" ("round_id", "position", "ball")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marks"
    ADD CONSTRAINT "marks_ball_check" CHECK ("ball" BETWEEN 1 AND 75),
    ADD CONSTRAINT "marks_called_ball_fkey"
        FOREIGN KEY ("round_id", "ball")
        REFERENCES "calls" ("round_id", "ball")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "co_winners"
    ADD CONSTRAINT "co_winners_lobby_id_fkey"
        FOREIGN KEY ("lobby_id") REFERENCES "lobbies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "co_winners_lobby_participant_fkey"
        FOREIGN KEY ("lobby_id", "participant_id")
        REFERENCES "participants" ("lobby_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "co_winners_round_lobby_fkey"
        FOREIGN KEY ("round_id", "lobby_id")
        REFERENCES "rounds" ("id", "lobby_id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "co_winners_card_fkey"
        FOREIGN KEY ("card_id", "round_id", "participant_id")
        REFERENCES "cards" ("id", "round_id", "participant_id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "co_winners_triggering_call_fkey"
        FOREIGN KEY ("triggering_call_id", "round_id")
        REFERENCES "calls" ("id", "round_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rounds"
    ADD CONSTRAINT "rounds_co_winner_triggering_call_fkey"
        FOREIGN KEY ("co_winner_triggering_call_id", "id")
        REFERENCES "calls" ("id", "round_id")
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "active_lobby_events"
    ADD CONSTRAINT "active_lobby_events_sequence_check" CHECK ("sequence" > 0),
    ADD CONSTRAINT "active_lobby_events_schema_version_check" CHECK ("schema_version" > 0),
    ADD CONSTRAINT "active_lobby_events_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    ADD CONSTRAINT "active_lobby_events_round_lobby_fkey"
        FOREIGN KEY ("round_id", "lobby_id")
        REFERENCES "rounds" ("id", "lobby_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "command_results"
    ADD CONSTRAINT "command_results_result_check" CHECK (jsonb_typeof("result") = 'object'),
    ADD CONSTRAINT "command_results_scope_sequence_check"
        CHECK (
          ("delivery_scope" = 'ACTIVE_LOBBY' AND "event_sequence" IS NOT NULL)
          OR ("delivery_scope" = 'PARTICIPANT_PRIVATE' AND "event_sequence" IS NULL)
        ),
    ADD CONSTRAINT "command_results_event_fkey"
        FOREIGN KEY ("lobby_id", "event_sequence")
        REFERENCES "active_lobby_events" ("lobby_id", "sequence") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "command_results_round_lobby_fkey"
        FOREIGN KEY ("round_id", "lobby_id")
        REFERENCES "rounds" ("id", "lobby_id") ON DELETE CASCADE ON UPDATE CASCADE;
