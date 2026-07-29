import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { consumeRealtimeTicketCredential } from "./realtime-ticket.js";

const TICKET = Buffer.alloc(32, 7).toString("base64url");

describe("realtime ticket authentication boundary", () => {
  test("validates and hashes the credential before deriving persisted identity", async () => {
    const hashes: Uint8Array[] = [];
    const identity = {
      lobbyId: "lobby-1",
      participantId: "participant-1",
      participantSessionId: "session-1",
    };

    await expect(
      consumeRealtimeTicketCredential(TICKET, {
        consumeRealtimeTicket: async ({ ticketHash }) => {
          hashes.push(ticketHash);
          return identity;
        },
      }),
    ).resolves.toEqual(identity);
    expect(hashes).toEqual([new Uint8Array(createHash("sha256").update(TICKET, "ascii").digest())]);
  });

  test.each([undefined, null, "malformed", "A".repeat(42) + "B", { ticket: TICKET }])(
    "rejects malformed credential input without consulting persistence",
    async (credential) => {
      let calls = 0;

      await expect(
        consumeRealtimeTicketCredential(credential, {
          consumeRealtimeTicket: async () => {
            calls += 1;
            return null;
          },
        }),
      ).resolves.toBeNull();
      expect(calls).toBe(0);
    },
  );

  test("rejects a consumed ticket while accepting a newly issued reconnect ticket", async () => {
    const reconnectTicket = Buffer.alloc(32, 8).toString("base64url");
    const validHashes = new Set(
      [TICKET, reconnectTicket].map((ticket) =>
        createHash("sha256").update(ticket, "ascii").digest("hex"),
      ),
    );
    const consumer = {
      consumeRealtimeTicket: async ({ ticketHash }: { ticketHash: Uint8Array }) => {
        const key = Buffer.from(ticketHash).toString("hex");
        return validHashes.delete(key)
          ? {
              lobbyId: "lobby-1",
              participantId: "participant-1",
              participantSessionId: "session-1",
            }
          : null;
      },
    };

    await expect(consumeRealtimeTicketCredential(TICKET, consumer)).resolves.not.toBeNull();
    await expect(consumeRealtimeTicketCredential(TICKET, consumer)).resolves.toBeNull();
    await expect(
      consumeRealtimeTicketCredential(reconnectTicket, consumer),
    ).resolves.not.toBeNull();
  });
});
