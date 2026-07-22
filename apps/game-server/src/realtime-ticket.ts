import { createHash } from "node:crypto";

import { RealtimeTicketSchema } from "@gamenight-bingo/contracts";

export interface ConsumedRealtimeTicketIdentity {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly participantSessionId: string;
}

export interface RealtimeTicketConsumer {
  consumeRealtimeTicket(input: {
    readonly ticketHash: Uint8Array;
  }): Promise<ConsumedRealtimeTicketIdentity | null>;
}

export async function consumeRealtimeTicketCredential(
  credential: unknown,
  consumer: RealtimeTicketConsumer,
): Promise<ConsumedRealtimeTicketIdentity | null> {
  const parsed = RealtimeTicketSchema.safeParse(credential);
  if (!parsed.success) return null;

  const ticketHash = new Uint8Array(createHash("sha256").update(parsed.data, "ascii").digest());
  return consumer.consumeRealtimeTicket({ ticketHash });
}
