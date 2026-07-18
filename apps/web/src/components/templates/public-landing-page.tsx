import { JsonLd } from "@/atoms";
import { CreateLobbyForm } from "@/organisms";

type PatternOption = {
  category: "standard" | "shape" | "letter" | "number" | "christmas";
  id: string;
  name: string;
};

type PublicLandingPageProps = {
  patterns: readonly PatternOption[];
};

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

export function PublicLandingPage({ patterns }: PublicLandingPageProps) {
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
          <a className="hero-jump" href="#create-lobby">
            Start a lobby
          </a>
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
          <aside className="privacy-note">
            <strong>Made for private game nights.</strong>
            <p>No account, public player directory, chat, or third-party analytics.</p>
          </aside>
        </div>
        <div id="create-lobby">
          <CreateLobbyForm patterns={patterns} />
        </div>
      </section>
    </main>
  );
}
