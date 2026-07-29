import {
  themeAssetRoles,
  themeCatalog,
  type ThemeDefinition,
  type ThemeVisualMotif,
} from "./catalog.js";
import { themeCssVariables } from "./preview.js";

const motifMarkup: Readonly<Record<ThemeVisualMotif, string>> = {
  animals: `<g fill="currentColor"><circle cx="60" cy="66" r="18"/><circle cx="36" cy="41" r="9"/><circle cx="53" cy="31" r="9"/><circle cx="70" cy="31" r="9"/><circle cx="86" cy="43" r="9"/></g>`,
  nature: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M24 80C28 35 62 19 96 24C91 62 70 92 24 80Z"/><path d="M31 76C52 61 68 47 89 31"/><path d="M48 65L44 43M64 52L70 31"/></g>`,
  hero: `<g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="7"><path d="M60 17L94 32L86 74L60 101L34 74L26 32Z"/><path d="M18 91C45 71 67 57 104 45"/><path d="M19 65L43 59M78 33L101 27"/></g>`,
  pirate: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><circle cx="48" cy="82" r="13"/><path d="M34 78L26 58L76 43L84 62L61 69"/><path d="M72 42L91 31M89 24L94 14M97 31L108 27"/></g>`,
  ghost: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M28 94V53C28 27 42 15 60 15S92 27 92 53V94L80 82L68 96L57 82L45 96Z"/><circle cx="49" cy="51" r="3" fill="currentColor"/><circle cx="72" cy="51" r="3" fill="currentColor"/></g>`,
  sports: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="7"><circle cx="59" cy="59" r="39"/><path d="M33 31C46 42 48 76 34 88M85 31C71 43 69 75 84 88"/><path d="M38 43L46 39M38 56L48 53M80 41L88 46M78 54L88 59"/></g>`,
  winter: `<g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="7"><path d="M60 15L29 52H44L22 79H50V102H70V79H98L76 52H91Z"/><rect x="45" y="69" width="30" height="25" rx="3"/><path d="M60 69V94M45 80H75"/></g>`,
  halloween: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M60 28C83 28 100 45 96 69C92 91 75 101 60 101S28 91 24 69C20 45 37 28 60 28Z"/><path d="M60 28C54 18 61 13 72 16M40 59L51 52M80 59L69 52M43 78C54 86 67 86 78 78"/></g>`,
  civic: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M60 15L70 45L102 45L76 64L86 96L60 77L34 96L44 64L18 45L50 45Z"/><path d="M18 102C43 89 77 89 102 102"/></g>`,
  hearts: `<g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="7"><path d="M61 100L27 68C5 47 34 17 60 42C86 17 115 47 93 68Z"/><path d="M60 50C78 31 101 54 84 71L61 93"/></g>`,
  birthday: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M30 55H90V98H30Z"/><path d="M30 72C41 82 50 63 60 72C70 82 80 63 90 72"/><path d="M47 55V37M73 55V37M44 31L47 23L50 31M70 31L73 23L76 31"/></g>`,
};

function motif(theme: ThemeDefinition, transform = ""): string {
  return `<g${transform.length === 0 ? "" : ` transform="${transform}"`}>${motifMarkup[theme.visuals.motif]}</g>`;
}

function winnerAccent(theme: ThemeDefinition): string {
  if (theme.visuals.motif === "hero") {
    return `<path d="M8 91C37 58 66 41 113 28" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="8"/>`;
  }
  if (theme.visuals.motif === "pirate") {
    return `<g fill="currentColor"><circle cx="22" cy="25" r="5"/><circle cx="96" cy="20" r="5"/><path d="M15 50L22 39L29 50ZM94 47L102 35L109 47Z"/></g>`;
  }
  return `<g fill="currentColor"><circle cx="16" cy="28" r="4"/><circle cx="104" cy="24" r="4"/><circle cx="97" cy="91" r="3"/><path d="M16 76L22 65L28 76ZM89 39L95 28L101 39Z"/></g>`;
}

function otherWinnerAccent(theme: ThemeDefinition): string {
  if (theme.visuals.motif === "pirate") {
    return `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="6"><path d="M10 92L109 78L111 96L12 109Z"/><path d="M22 94C43 78 64 103 87 85"/><circle cx="24" cy="94" r="3" fill="currentColor"/><circle cx="55" cy="92" r="3" fill="currentColor"/><rect x="86" y="70" width="24" height="18" rx="3"/><path d="M86 79H110M98 70V88M16 70L20 61L24 70"/></g>`;
  }
  if (theme.visuals.motif === "sports") {
    return `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><rect x="10" y="10" width="100" height="37" rx="6"/><circle cx="31" cy="29" r="5" fill="currentColor"/><circle cx="60" cy="29" r="5" fill="currentColor"/><circle cx="89" cy="29" r="5" fill="currentColor"/><path d="M20 100C45 82 76 82 101 100"/></g>`;
  }
  return `<path d="M12 96C38 84 82 84 108 96" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="7"/>`;
}

function otherWinnerMotif(theme: ThemeDefinition): string {
  if (theme.visuals.motif === "pirate") {
    return `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="6"><circle cx="60" cy="49" r="24"/><path d="M60 28L67 43L82 49L67 56L60 70L53 56L38 49L53 43Z"/></g>`;
  }
  return motif(theme, "translate(39 35) scale(.35)");
}

export function renderThemeSprite(theme: ThemeDefinition): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <symbol id="icon" viewBox="0 0 120 120">${motif(theme)}</symbol>
  <symbol id="dauber" viewBox="0 0 120 120"><path d="M38 12H82L76 34H44ZM32 35H88L96 106H24Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="7"/>${motif(theme, "translate(39 42) scale(.35)")}</symbol>
  <symbol id="call-ball" viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-width="7"/>${motif(theme, "translate(39 10) scale(.34)")}</symbol>
  <symbol id="card-decoration" viewBox="0 0 120 120"><path d="M8 42V8H42M78 8H112V42M112 78V112H78M42 112H8V78" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="7"/>${motif(theme, "translate(44 44) scale(.27)")}</symbol>
  <symbol id="winner" viewBox="0 0 120 120">${winnerAccent(theme)}${motif(theme, "translate(27 25) scale(.55)")}</symbol>
  <symbol id="other-winner" viewBox="0 0 120 120">${otherWinnerAccent(theme)}${otherWinnerMotif(theme)}</symbol>
</svg>
`;
}

const allowedAttributes: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["xmlns", "viewBox"]),
  symbol: new Set(["id", "viewBox"]),
  g: new Set(["fill", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width", "transform"]),
  circle: new Set(["cx", "cy", "r", "fill", "stroke", "stroke-width"]),
  path: new Set(["d", "fill", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"]),
  rect: new Set([
    "x",
    "y",
    "width",
    "height",
    "rx",
    "fill",
    "stroke",
    "stroke-linejoin",
    "stroke-width",
  ]),
};

export function validateThemeSprite(sprite: string): readonly string[] {
  const errors: string[] = [];
  const tokens = sprite.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join("") !== sprite) errors.push("Sprite contains malformed markup.");

  const stack: string[] = [];
  const symbolIds = new Set<string>();
  let rootCount = 0;
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (token.trim().length > 0) errors.push("Sprite contains text content.");
      continue;
    }

    const closing = /^<\/([a-z][a-z-]*)>$/.exec(token);
    if (closing !== null) {
      const name = closing[1] ?? "";
      if (stack.pop() !== name) errors.push(`Sprite closes ${name} out of order.`);
      continue;
    }

    const opening = /^<([a-z][a-z-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (opening === null) {
      errors.push("Sprite contains unsupported markup syntax.");
      continue;
    }
    const [, name = "", attributeSource = "", selfClosing = ""] = opening;
    const allowed = allowedAttributes[name];
    if (allowed === undefined) errors.push(`Sprite element ${name} is not allowed.`);

    const parent = stack.at(-1);
    if (name === "svg") {
      rootCount += 1;
      if (parent !== undefined) errors.push("Sprite nests an svg root.");
    } else if (name === "symbol") {
      if (parent !== "svg") errors.push("Sprite symbols must be direct root children.");
    } else if (parent !== "symbol" && parent !== "g") {
      errors.push(`Sprite geometry ${name} has an invalid parent.`);
    }

    const attributes = new Map<string, string>();
    let remainder = attributeSource;
    while (remainder.length > 0) {
      const attribute = /^\s+([A-Za-z_:][\w:.-]*)="([^"]*)"/.exec(remainder);
      if (attribute === null) {
        errors.push(`Sprite ${name} has malformed attributes.`);
        break;
      }
      const [, attributeName = "", value = ""] = attribute;
      if (attributes.has(attributeName)) errors.push(`Sprite ${name} repeats ${attributeName}.`);
      attributes.set(attributeName, value);
      if (allowed?.has(attributeName) !== true) {
        errors.push(`Sprite ${name} attribute ${attributeName} is not allowed.`);
      }
      if (
        attributeName !== "xmlns" &&
        /[<>&]|(?:javascript|data|https?):|url\s*\(|@import/i.test(value)
      ) {
        errors.push(`Sprite ${name} attribute ${attributeName} has an unsafe value.`);
      }
      remainder = remainder.slice(attribute[0].length);
    }

    if (name === "svg") {
      if (attributes.get("xmlns") !== "http://www.w3.org/2000/svg") {
        errors.push("Sprite root has an invalid namespace.");
      }
      if (attributes.get("viewBox") !== "0 0 120 120") {
        errors.push("Sprite root has an invalid viewBox.");
      }
    }
    if (name === "symbol") {
      const id = attributes.get("id") ?? "";
      if (!themeAssetRoles.includes(id as (typeof themeAssetRoles)[number])) {
        errors.push(`Sprite symbol ${id} is not a required role.`);
      }
      if (symbolIds.has(id)) errors.push(`Sprite repeats symbol ${id}.`);
      symbolIds.add(id);
      if (attributes.get("viewBox") !== "0 0 120 120") {
        errors.push(`Sprite symbol ${id} has an invalid viewBox.`);
      }
    }

    if (selfClosing.length === 0) stack.push(name);
  }

  if (stack.length > 0) errors.push("Sprite contains unclosed elements.");
  if (rootCount !== 1) errors.push("Sprite must contain exactly one root.");
  if (
    symbolIds.size !== themeAssetRoles.length ||
    themeAssetRoles.some((role) => !symbolIds.has(role))
  ) {
    errors.push("Sprite must contain every required symbol exactly once.");
  }
  return errors;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderThemeAssetGalleryHtml(): string {
  const initialTheme = themeCatalog[0];
  const themes = themeCatalog.map(({ id, name, visuals }) => ({ id, name, visuals }));
  const initialVariables = Object.entries(themeCssVariables(initialTheme))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const roleLabel: Readonly<Record<(typeof themeAssetRoles)[number], string>> = {
    icon: "Theme icon",
    dauber: "Dauber",
    "call-ball": "Call-ball treatment",
    "card-decoration": "Card decoration",
    winner: "Winner scene",
    "other-winner": "Other-player-won scene",
  };
  const specimens = themeAssetRoles
    .map(
      (role) => `<article class="asset-card" data-role="${role}">
        <div class="asset-frame"><span aria-hidden="true" class="asset-fallback">◇</span><svg aria-hidden="true" data-art focusable="false" viewBox="0 0 120 120"><use href="../apps/web/public${initialTheme.visuals.spriteUrl}#${role}"></use></svg></div>
        <h2>${roleLabel[role]}</h2><p data-concept="${role}">${escapeHtml(initialTheme.visuals.concepts[role])}</p>
      </article>`,
    )
    .join("\n");

  return `<!doctype html>
<!-- prettier-ignore -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>GameNight Bingo theme visual assets</title>
  <style>
    * { box-sizing: border-box; }
    html { background: #eef1f3; color: #17243a; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; }
    main { background: var(--bingo-theme-canvas); color: var(--bingo-theme-text-primary); margin: 0 auto; min-height: 100vh; padding: clamp(1rem, 4vw, 3rem); }
    h1 { font-family: Georgia, serif; font-size: clamp(2.6rem, 10vw, 6rem); line-height: .9; margin: .4rem 0 1rem; max-width: 10ch; }
    .eyebrow { color: var(--bingo-theme-text-secondary); font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .controls { align-items: end; display: flex; flex-wrap: wrap; gap: 1rem; margin: 2rem 0; }
    label { display: grid; font-weight: 800; gap: .35rem; }
    select { background: var(--bingo-theme-surface); border: 3px solid var(--bingo-theme-border); border-radius: .65rem; color: var(--bingo-theme-text-primary); font: inherit; min-height: 44px; padding: .55rem 2.5rem .55rem .75rem; }
    select:focus-visible { box-shadow: 0 0 0 7px var(--bingo-theme-focus-outer); outline: 4px solid var(--bingo-theme-focus-inner); outline-offset: 3px; }
    .fallback-note { border-left: 4px solid var(--bingo-theme-border); max-width: 65ch; padding: .7rem 1rem; }
    .gallery { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .asset-card { background: var(--bingo-theme-surface); border: 3px solid var(--bingo-theme-border); border-radius: 1rem; min-width: 0; padding: 1rem; }
    .asset-frame { align-items: center; aspect-ratio: 4 / 3; background: var(--bingo-theme-surface-elevated); border: 3px solid var(--bingo-theme-border); border-radius: .75rem; color: var(--bingo-theme-text-link); display: grid; isolation: isolate; justify-items: center; overflow: hidden; position: relative; }
    .asset-frame > * { grid-area: 1 / 1; }
    .asset-frame svg { color: inherit; height: 88%; pointer-events: none; width: 88%; z-index: 1; }
    .asset-fallback { color: var(--bingo-theme-text-secondary); font-size: 4rem; z-index: 0; }
    main[data-assets-loaded="false"] .asset-frame svg { opacity: 0; }
    main[data-assets-loaded="true"] .asset-fallback { opacity: 0; }
    .asset-card h2 { font-family: Georgia, serif; margin: .9rem 0 .4rem; }
    .asset-card p { line-height: 1.5; margin: 0; }
    [data-role="winner"] .asset-frame { background: var(--bingo-theme-result-winner-background); color: var(--bingo-theme-result-winner-text); }
    [data-role="other-winner"] .asset-frame { background: var(--bingo-theme-result-other-winner-background); color: var(--bingo-theme-result-other-winner-text); }
    @media (min-width: 50rem) { .gallery { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (prefers-contrast: more) { .asset-frame svg, .asset-fallback { display: none; } .asset-card, .asset-frame, select { border-width: 4px; } }
    @media (forced-colors: active) { .asset-frame svg, .asset-fallback { display: none; } .asset-card, .asset-frame, select { background: Canvas; border-color: CanvasText; color: CanvasText; } select:focus-visible { box-shadow: none; outline-color: Highlight; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <main data-assets-loaded="false" data-theme-id="${initialTheme.id}" style="${initialVariables}">
    <p class="eyebrow">Original vector review</p>
    <h1>Theme visual assets</h1>
    <p>Each selected theme loads one small static SVG sprite. Game labels and states remain real HTML; these silent visuals never carry meaning.</p>
    <div class="controls"><label for="theme-select">Theme<select id="theme-select">${themeCatalog.map(({ id, name }) => `<option value="${id}">${escapeHtml(name)}</option>`).join("")}</select></label></div>
    <p class="fallback-note"><strong>Decorative assets unavailable?</strong> The geometric fallback and all game content remain usable when the selected sprite cannot load.</p>
    <img alt="" aria-hidden="true" data-sprite-preload hidden src="../apps/web/public${initialTheme.visuals.spriteUrl}">
    <section aria-label="Selected theme artwork" class="gallery">${specimens}</section>
  </main>
  <script>
    const themes = ${JSON.stringify(themes)};
    const select = document.querySelector("#theme-select");
    const main = document.querySelector("main");
    const preload = document.querySelector("[data-sprite-preload]");
    const revealLoadedSprite = () => {
      if (preload.complete && preload.naturalWidth > 0) { main.dataset.assetsLoaded = "true"; }
    };
    preload.addEventListener("load", () => { main.dataset.assetsLoaded = "true"; });
    preload.addEventListener("error", () => { main.dataset.assetsLoaded = "false"; });
    const applyTheme = () => {
      const theme = themes.find(({ id }) => id === select.value) || themes[0];
      const nextSprite = "../apps/web/public" + theme.visuals.spriteUrl;
      main.dataset.themeId = theme.id;
      if (preload.getAttribute("src") !== nextSprite) {
        main.dataset.assetsLoaded = "false";
        preload.src = nextSprite;
        revealLoadedSprite();
      }
      document.querySelectorAll("[data-art] use").forEach((use) => {
        const role = use.closest("[data-role]").dataset.role;
        use.setAttribute("href", "../apps/web/public" + theme.visuals.spriteUrl + "#" + role);
      });
      document.querySelectorAll("[data-concept]").forEach((description) => {
        description.textContent = theme.visuals.concepts[description.dataset.concept];
      });
      const colors = ${JSON.stringify(Object.fromEntries(themeCatalog.map((theme) => [theme.id, themeCssVariables(theme)])))};
      Object.entries(colors[theme.id]).forEach(([name, value]) => main.style.setProperty(name, value));
    };
    select.addEventListener("change", applyTheme);
    revealLoadedSprite();
  </script>
</body>
</html>
`;
}
