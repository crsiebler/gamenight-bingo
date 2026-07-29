-- CreateIndex
CREATE UNIQUE INDEX "participant_sessions_lobby_participant_id_key"
    ON "participant_sessions"("lobby_id", "participant_id", "id");

-- CreateTable
CREATE TABLE "realtime_tickets" (
    "token_hash" BYTEA NOT NULL,
    "lobby_id" VARCHAR(128) NOT NULL,
    "participant_id" VARCHAR(128) NOT NULL,
    "participant_session_id" VARCHAR(128) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "realtime_tickets_pkey" PRIMARY KEY ("token_hash"),
    CONSTRAINT "realtime_tickets_expiry_check" CHECK ("expires_at" > "issued_at")
);

-- CreateIndex
CREATE INDEX "realtime_tickets_expires_at_idx" ON "realtime_tickets"("expires_at");

-- AddForeignKey
ALTER TABLE "realtime_tickets"
    ADD CONSTRAINT "realtime_tickets_lobby_id_fkey"
    FOREIGN KEY ("lobby_id") REFERENCES "lobbies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_tickets"
    ADD CONSTRAINT "realtime_tickets_lobby_id_participant_id_fkey"
    FOREIGN KEY ("lobby_id", "participant_id")
    REFERENCES "participants"("lobby_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_tickets"
    ADD CONSTRAINT "realtime_tickets_lobby_id_participant_id_participant_session_id_fkey"
    FOREIGN KEY ("lobby_id", "participant_id", "participant_session_id")
    REFERENCES "participant_sessions"("lobby_id", "participant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
