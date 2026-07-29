import { JsonLd } from "@/atoms";
import { CreateLobbyForm, JoinLobbyForm } from "@/organisms";

type PatternOption = {
  category: "standard" | "shape" | "letter" | "number" | "christmas";
  id: string;
  name: string;
};

type PublicLandingPageProps = {
  initialLobbyCode?: string;
  lobbyIdleTtlSeconds?: number;
  patterns: readonly PatternOption[];
  playerReconnectWindowSeconds?: number;
};

const SMALL_NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

function durationLabel(seconds: number): string {
  const [count, unit] = seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  const countLabel = SMALL_NUMBER_WORDS[count] ?? String(count);
  return `${countLabel} ${unit}${count === 1 ? "" : "s"}`;
}

export const HOW_TO_STEPS = [
  {
    name: "Choose your setup",
    text: "Pick a theme, winning pattern, and call pace.",
  },
  {
    name: "Invite your players",
    text: "Share the private six-character code with friends and family.",
  },
  {
    name: "Run the round",
    text: "Call balls manually or let GameNight Bingo keep the pace.",
  },
] as const;

const publicSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      name: "GameNight Bingo",
      applicationCategory: "GameApplication",
      browserRequirements: "Requires JavaScript and a modern web browser.",
      description: "Create and host a private 75-ball bingo game for friends and family.",
      operatingSystem: "Any",
    },
    {
      "@type": "HowTo",
      name: "How to host a GameNight Bingo game",
      step: HOW_TO_STEPS.map((step) => ({ "@type": "HowToStep", ...step })),
    },
  ],
} as const;

export function PublicLandingPage({
  initialLobbyCode,
  lobbyIdleTtlSeconds = 1_800,
  patterns,
  playerReconnectWindowSeconds = 120,
}: PublicLandingPageProps) {
  return (
    <main>
      <JsonLd schema={publicSchema} />
      <section className="hero-shell">
        <div className="hero-copy">
          <p className="eyebrow">Private 75-ball bingo</p>
          <h1>Make tonight a bingo night.</h1>
          <p className="hero-intro">
            Host a lively, account-free game for your favorite people. You set the pattern and pace;
            GameNight Bingo keeps the round together.
          </p>
          <div className="hero-actions">
            <a className="hero-jump" href="#create-lobby">
              Start a lobby
            </a>
            <a className="hero-jump hero-jump-secondary" href="#join-lobby">
              Join with a code
            </a>
          </div>
        </div>
        <div aria-hidden="true" className="bingo-board">
          <span className="board-label">B</span>
          <span className="board-label">I</span>
          <span className="board-label">N</span>
          <span className="board-label">G</span>
          <span className="board-label">O</span>
          {[7, 18, 33, 49, 68, 12, 22, "FREE", 54, 73].map((ball) => (
            <span
              className={ball === "FREE" ? "board-ball board-ball-free" : "board-ball"}
              key={ball}
            >
              {ball}
            </span>
          ))}
        </div>
      </section>

      <section className="join-shell" id="join-lobby">
        <JoinLobbyForm initialLobbyCode={initialLobbyCode ?? ""} />
      </section>

      <section className="landing-grid">
        <div className="how-to">
          <p className="eyebrow">Three easy moves</p>
          <h2>How to host</h2>
          <ol>
            {HOW_TO_STEPS.map((step) => (
              <li key={step.name}>
                <strong>{step.name}</strong> {step.text}
              </li>
            ))}
          </ol>
          <aside aria-labelledby="privacy-heading" className="privacy-note">
            <h3 id="privacy-heading">Privacy and your data</h3>
            <p>
              A necessary, lobby-scoped cookie recognizes your participant session on this device.
              The server stores only its cryptographic hash.
            </p>
            <p>
              After you disconnect, the same device can rejoin your participant slot for{" "}
              {durationLabel(playerReconnectWindowSeconds)}. We do not fingerprint your device or
              collect unnecessary device attributes, and no third-party analytics run on private
              lobby routes.
            </p>
            <p>
              Eligible inactive lobbies are deleted after {durationLabel(lobbyIdleTtlSeconds)},
              together with their server-side game and participant-session data. Active games with
              calls or connections are protected from inactivity deletion.
            </p>
          </aside>
        </div>
        <div id="create-lobby">
          <CreateLobbyForm patterns={patterns} />
        </div>
      </section>
    </main>
  );
}
