import { type Prisma } from "../generated/prisma/client.js";

export async function expireDueParticipantSessions(
  transaction: Prisma.TransactionClient,
  lobbyId: string,
  now: Date,
): Promise<number> {
  const dueSessions = await transaction.participantSession.findMany({
    where: {
      lobbyId,
      status: "DISCONNECTED",
      rejoinUntil: { lte: now },
      participant: { departedAt: null },
    },
    select: { id: true, participantId: true, rejoinUntil: true },
    orderBy: { rejoinUntil: "asc" },
  });
  const participantDeadlines = new Map<string, Date>();
  for (const session of dueSessions) {
    if (session.rejoinUntil === null) {
      throw new Error("Disconnected participant sessions require a rejoin deadline.");
    }
    await transaction.realtimeTicket.deleteMany({
      where: { participantSessionId: session.id },
    });
    await transaction.participantSession.update({
      where: { id: session.id },
      data: { status: "DEPARTED", departedAt: session.rejoinUntil },
    });
    participantDeadlines.set(session.participantId, session.rejoinUntil);
  }

  let departedParticipants = 0;
  for (const [participantId, departedAt] of participantDeadlines) {
    const validSessions = await transaction.participantSession.count({
      where: {
        lobbyId,
        participantId,
        status: { in: ["ACTIVE", "DISCONNECTED"] },
      },
    });
    if (validSessions !== 0) {
      continue;
    }
    const departed = await transaction.participant.updateMany({
      where: { id: participantId, lobbyId, departedAt: null },
      data: { departedAt },
    });
    departedParticipants += departed.count;
  }
  return departedParticipants;
}
