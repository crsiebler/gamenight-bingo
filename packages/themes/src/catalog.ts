export type HexColor = `#${string}`;

export type ThemeColorSet = {
  readonly background: HexColor;
  readonly text: HexColor;
  readonly border: HexColor;
  readonly indicator: HexColor;
};

export type ThemeTokens = {
  readonly canvas: HexColor;
  readonly surface: HexColor;
  readonly surfaceInverse: HexColor;
  readonly surfaceElevated: HexColor;
  readonly border: HexColor;
  readonly text: {
    readonly primary: HexColor;
    readonly secondary: HexColor;
    readonly inverse: HexColor;
    readonly link: HexColor;
    readonly danger: HexColor;
  };
  readonly focus: {
    readonly inner: HexColor;
    readonly outer: HexColor;
    readonly widthPx: number;
    readonly offsetPx: number;
  };
  readonly card: {
    readonly surface: HexColor;
    readonly border: HexColor;
    readonly header: ThemeColorSet;
    readonly uncalled: ThemeColorSet;
    readonly called: ThemeColorSet;
    readonly marked: ThemeColorSet;
    readonly free: ThemeColorSet;
    readonly unavailable: ThemeColorSet;
  };
  readonly state: {
    readonly neutral: ThemeColorSet;
    readonly info: ThemeColorSet;
    readonly success: ThemeColorSet;
    readonly warning: ThemeColorSet;
    readonly danger: ThemeColorSet;
  };
  readonly ball: {
    readonly current: ThemeColorSet;
    readonly history: ThemeColorSet;
  };
  readonly result: {
    readonly checking: ThemeColorSet;
    readonly winner: ThemeColorSet;
    readonly otherWinner: ThemeColorSet;
  };
  readonly motion: {
    readonly stateTransitionMs: number;
    readonly daubMs: number;
    readonly celebrationMs: number;
  };
};

export type ThemeMoodboard = {
  readonly atmosphere: string;
  readonly motifs: readonly string[];
  readonly paletteIntent: string;
  readonly shapeLanguage: string;
  readonly texture: string;
  readonly motionCharacter: string;
  readonly originalDirection: string;
  readonly avoid: readonly string[];
};

export type ThemeDefinition = {
  readonly id: string;
  readonly name: string;
  readonly moodboard: ThemeMoodboard;
  readonly tokens: ThemeTokens;
};

type ThemePalette = {
  readonly canvas: HexColor;
  readonly surface: HexColor;
  readonly surfaceElevated: HexColor;
  readonly ink: HexColor;
  readonly mutedInk: HexColor;
  readonly primary: HexColor;
  readonly primaryText: HexColor;
  readonly secondary: HexColor;
  readonly secondaryText: HexColor;
  readonly accent: HexColor;
  readonly accentText: HexColor;
};

const WHITE = "#ffffff";
const DANGER = "#8f1d1d";

function colors(background: HexColor, text: HexColor): ThemeColorSet {
  return { background, text, border: text, indicator: text };
}

function tokens(palette: ThemePalette): ThemeTokens {
  return {
    canvas: palette.canvas,
    surface: palette.surface,
    surfaceInverse: palette.primary,
    surfaceElevated: palette.surfaceElevated,
    border: palette.ink,
    text: {
      primary: palette.ink,
      secondary: palette.mutedInk,
      inverse: WHITE,
      link: palette.primary,
      danger: DANGER,
    },
    focus: { inner: WHITE, outer: palette.ink, widthPx: 4, offsetPx: 3 },
    card: {
      surface: palette.surface,
      border: palette.ink,
      header: colors(palette.primary, palette.primaryText),
      uncalled: colors(palette.surfaceElevated, palette.ink),
      called: colors(palette.accent, palette.accentText),
      marked: colors(palette.primary, palette.primaryText),
      free: colors(palette.secondary, palette.secondaryText),
      unavailable: colors("#e3e6e8", "#26343f"),
    },
    state: {
      neutral: colors("#e3e6e8", "#26343f"),
      info: colors("#dcebf8", "#173b61"),
      success: colors("#dcefe6", "#1c563d"),
      warning: colors("#fff1c2", "#664400"),
      danger: colors("#fbe1e1", "#7d1f1f"),
    },
    ball: {
      current: colors(palette.primary, palette.primaryText),
      history: colors(palette.surfaceElevated, palette.ink),
    },
    result: {
      checking: colors(palette.accent, palette.accentText),
      winner: colors(palette.primary, palette.primaryText),
      otherWinner: colors(palette.secondary, palette.secondaryText),
    },
    motion: { stateTransitionMs: 160, daubMs: 220, celebrationMs: 700 },
  };
}

const SHARED_AVOID = [
  "Recognizable characters, franchise costume language, or copied catchphrases",
  "Brand logos, team marks, official seals, or protected trade dress",
  "Cultural caricatures, gender stereotypes, gore, or hostile loser imagery",
] as const;

function defineTheme<const Id extends string, const Name extends string>(input: {
  readonly id: Id;
  readonly name: Name;
  readonly palette: ThemePalette;
  readonly moodboard: Omit<ThemeMoodboard, "avoid"> & { readonly avoid?: readonly string[] };
}): ThemeDefinition & { readonly id: Id; readonly name: Name } {
  return {
    id: input.id,
    name: input.name,
    moodboard: {
      ...input.moodboard,
      avoid: [...SHARED_AVOID, ...(input.moodboard.avoid ?? [])],
    },
    tokens: tokens(input.palette),
  };
}

export const themeCatalog = [
  defineTheme({
    id: "animals",
    name: "Animals",
    palette: {
      canvas: "#fff8eb",
      surface: "#ffffff",
      surfaceElevated: "#f7ead6",
      ink: "#172b35",
      mutedInk: "#44545b",
      primary: "#7a2e2a",
      primaryText: WHITE,
      secondary: "#075a55",
      secondaryText: WHITE,
      accent: "#f2c14e",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere: "A warm, curious field guide made for a welcoming all-ages game night.",
      motifs: ["paw-print geometry", "feather arcs", "leaf and habitat silhouettes"],
      paletteIntent:
        "Cream paper, auburn warmth, deep teal, and sunlight gold feel friendly without becoming childish.",
      shapeLanguage:
        "Rounded tracks and irregular organic frames suggest movement while keeping controls calm and obvious.",
      texture:
        "Subtle recycled-paper grain and sparse linework provide tactility without obscuring text or card numbers.",
      motionCharacter:
        "Short curious peeks and gentle tracks may decorate transitions, with every state settling immediately.",
      originalDirection:
        "Use only original simplified habitat and animal-trace geometry rather than recognizable mascots.",
    },
  }),
  defineTheme({
    id: "nature",
    name: "Nature",
    palette: {
      canvas: "#f3f8ef",
      surface: "#ffffff",
      surfaceElevated: "#e4efdf",
      ink: "#172d27",
      mutedInk: "#41564d",
      primary: "#24513f",
      primaryText: WHITE,
      secondary: "#2b5263",
      secondaryText: WHITE,
      accent: "#d6a436",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A calm trail-map composition balancing forest shade, open water, and warm afternoon light.",
      motifs: ["contour lines", "layered leaves", "water ripples"],
      paletteIntent:
        "Mist green, evergreen, lake blue, and ochre create an outdoors palette with strong readable anchors.",
      shapeLanguage:
        "Layered topographic curves and vertical growth lines give structure without competing with the grid.",
      texture:
        "Fine contour strokes and broad matte color fields evoke maps and pressed leaves without visual noise.",
      motionCharacter:
        "Slow drift and brief leaf-settle cues may support decoration, never timing or game meaning.",
      originalDirection:
        "Build original botanical and landscape abstractions instead of tracing protected illustrations.",
    },
  }),
  defineTheme({
    id: "superheroes",
    name: "Superheroes",
    palette: {
      canvas: "#f5f7fb",
      surface: "#ffffff",
      surfaceElevated: "#e7edf7",
      ink: "#17243a",
      mutedInk: "#42516a",
      primary: "#173f7a",
      primaryText: WHITE,
      secondary: "#842d3a",
      secondaryText: WHITE,
      accent: "#e2ad2f",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "An optimistic kinetic comic layout about teamwork, courage, and shared celebration.",
      motifs: ["original ray fields", "abstract shield geometry", "motion-line bursts"],
      paletteIntent:
        "Off-white, midnight blue, cobalt, coral-red, and amber provide bold panels without franchise mimicry.",
      shapeLanguage:
        "Strong diagonals, offset panels, and compact bursts communicate energy while preserving reading order.",
      texture:
        "Sparse original halftone fields can appear only as decoration behind opaque accessible surfaces.",
      motionCharacter:
        "One quick swoop may introduce decoration, then stop; reduced motion shows the final composition at once.",
      originalDirection:
        "Create an original generic hero language with no character likenesses, emblems, uniforms, or slogans.",
      avoid: ["Color blocking strongly associated with a named hero or entertainment property"],
    },
  }),
  defineTheme({
    id: "pirates",
    name: "Pirates",
    palette: {
      canvas: "#fbf3df",
      surface: "#ffffff",
      surfaceElevated: "#eee0bd",
      ink: "#25333a",
      mutedInk: "#505b5f",
      primary: "#25475a",
      primaryText: WHITE,
      secondary: "#633a24",
      secondaryText: WHITE,
      accent: "#c69b45",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A playful storybook voyage centered on maps, teamwork, and a bright horizon rather than menace.",
      motifs: ["rope curves", "compass geometry", "map routes and wave lines"],
      paletteIntent:
        "Parchment, deep sea blue, warm brown, and brass create adventure while retaining crisp contrast.",
      shapeLanguage:
        "Curved routes, stamped circles, and sturdy plank-like rectangles support a clear navigational rhythm.",
      texture:
        "Light map speckle and line hatching stay outside text and number surfaces to preserve legibility.",
      motionCharacter:
        "A short rolling-wave or compass-settle gesture may decorate success before becoming fully static.",
      originalDirection:
        "Use original seafaring symbols and a cartoon tone without copying fictional crews, flags, or ships.",
      avoid: [
        "Violent punishment, hostile walk-the-plank loss scenes, or demeaning pirate stereotypes",
      ],
    },
  }),
  defineTheme({
    id: "ghosts",
    name: "Ghosts",
    palette: {
      canvas: "#f5f2fb",
      surface: "#ffffff",
      surfaceElevated: "#e9e2f4",
      ink: "#28233f",
      mutedInk: "#514a68",
      primary: "#352b67",
      primaryText: WHITE,
      secondary: "#5a3a73",
      secondaryText: WHITE,
      accent: "#8fd8c8",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A friendly moonlit gathering with soft mystery, gentle humor, and no horror dependence.",
      motifs: ["floating sheet curves", "moon crescents", "fog ribbons"],
      paletteIntent:
        "Fog white, indigo, lavender, and mint-aqua feel nocturnal while keeping cards bright and direct.",
      shapeLanguage:
        "Soft vertical floats and rounded scallops contrast with firm rectangular interaction boundaries.",
      texture:
        "Translucent-looking layers are illustrative only; all semantic surfaces remain opaque and contrast-tested.",
      motionCharacter:
        "A slow decorative float can stop instantly, while controls and announcements remain unaffected.",
      originalDirection:
        "Draw original friendly spectral silhouettes without recreating recognizable characters or films.",
    },
  }),
  defineTheme({
    id: "sports",
    name: "Sports",
    palette: {
      canvas: "#f4f7f5",
      surface: "#ffffff",
      surfaceElevated: "#e4ece7",
      ink: "#172b35",
      mutedInk: "#43565d",
      primary: "#173b61",
      primaryText: WHITE,
      secondary: "#27613f",
      secondaryText: WHITE,
      accent: "#e09b35",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "An inclusive community recreation night inspired by scoreboards, teamwork, and shared effort.",
      motifs: ["scoreboard blocks", "field and court lines", "multi-sport ball arcs"],
      paletteIntent:
        "Stadium navy, field green, warm orange, and clean white create an energetic neutral foundation.",
      shapeLanguage:
        "Measured lanes, bold numerals, and modular score panels keep information structured and quick to scan.",
      texture:
        "Very light field markings and perforation dots may frame content but never sit beneath essential labels.",
      motionCharacter:
        "Brief score flips or trajectory arcs may celebrate updates, with no flashing or repeated motion.",
      originalDirection:
        "Represent multiple recreational and adaptive sports through original generic equipment geometry.",
      avoid: [
        "Professional team colors, league marks, athlete likenesses, or winner-versus-loser taunting",
      ],
    },
  }),
  defineTheme({
    id: "christmas",
    name: "Christmas",
    palette: {
      canvas: "#fbf7ea",
      surface: "#ffffff",
      surfaceElevated: "#efe8d2",
      ink: "#20352e",
      mutedInk: "#4b5b55",
      primary: "#1f573e",
      primaryText: WHITE,
      secondary: "#7b2936",
      secondaryText: WHITE,
      accent: "#d3a52f",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A warm winter paper-craft gathering focused on lights, greenery, gifts, and generous welcome.",
      motifs: ["paper-cut evergreen", "ribbon loops", "warm light dots"],
      paletteIntent:
        "Snow cream, pine, cranberry, and muted gold create a festive but readable seasonal palette.",
      shapeLanguage:
        "Layered paper edges, tidy ribbons, and simple ornament circles frame content without crowding it.",
      texture:
        "Matte paper and soft needle-line details remain decorative and disappear cleanly in contrast modes.",
      motionCharacter:
        "A single light shimmer or ribbon settle may accompany celebration, never loop or carry meaning.",
      originalDirection:
        "Use original winter celebration craftwork without branded characters, songs, or commercial imagery.",
      avoid: [
        "Assuming every participant shares a faith practice or using sacred symbols as casual decoration",
      ],
    },
  }),
  defineTheme({
    id: "halloween",
    name: "Halloween",
    palette: {
      canvas: "#f8f1e8",
      surface: "#ffffff",
      surfaceElevated: "#ede2d6",
      ink: "#2a2733",
      mutedInk: "#554f5d",
      primary: "#302940",
      primaryText: WHITE,
      secondary: "#653876",
      secondaryText: WHITE,
      accent: "#e58a2c",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A playful autumn night with porch-light warmth, theatrical shadows, and gentle surprise.",
      motifs: ["pumpkin facets", "bat-wing geometry", "cobweb corner lines"],
      paletteIntent:
        "Cream, charcoal, violet, and pumpkin orange feel seasonal without sacrificing bright reading surfaces.",
      shapeLanguage:
        "Angular silhouettes and rounded lantern forms alternate around stable, high-contrast controls.",
      texture:
        "Paper-cut shadow layers and sparse web lines stay ornamental and never encode called or marked state.",
      motionCharacter:
        "One playful pop or bat crossing may decorate a result, with static immediate reduced-motion output.",
      originalDirection:
        "Create original autumn-night forms with friendly expression and no borrowed horror properties.",
      avoid: [
        "Gore, startle-dependent interaction, occult stereotypes, or frightening loss treatment",
      ],
    },
  }),
  defineTheme({
    id: "july-4th",
    name: "July 4th",
    palette: {
      canvas: "#f6f7fa",
      surface: "#ffffff",
      surfaceElevated: "#e7edf4",
      ink: "#17283e",
      mutedInk: "#46566a",
      primary: "#173b66",
      primaryText: WHITE,
      secondary: "#7f2d34",
      secondaryText: WHITE,
      accent: "#7db6d6",
      accentText: "#17243a",
    },
    moodboard: {
      atmosphere:
        "A relaxed summer civic picnic with night-sky sparkle and room for many ways of belonging.",
      motifs: ["abstract star fields", "bunting arcs", "firework radial lines"],
      paletteIntent:
        "Cream-white, navy, restrained brick red, and sky blue keep the celebration clear and balanced.",
      shapeLanguage:
        "Open radial bursts and repeating flag-like triangles create rhythm around stable rectangular content.",
      texture:
        "Light paper bunting and sparse night-sky dots remain removable decoration behind opaque information panels.",
      motionCharacter:
        "One slow radial reveal may decorate a win, with no flashing and an immediate static alternative.",
      originalDirection:
        "Use original civic celebration geometry without official seals, political messaging, or copied emblems.",
      avoid: [
        "Militaristic victory framing, partisan symbols, or imagery that excludes participants",
      ],
    },
  }),
  defineTheme({
    id: "valentines-day",
    name: "Valentine's Day",
    palette: {
      canvas: "#fff5f6",
      surface: "#ffffff",
      surfaceElevated: "#f5e2e7",
      ink: "#382530",
      mutedInk: "#604b56",
      primary: "#7b2848",
      primaryText: WHITE,
      secondary: "#603352",
      secondaryText: WHITE,
      accent: "#e2a0b0",
      accentText: "#382530",
    },
    moodboard: {
      atmosphere:
        "An inclusive handmade-card table celebrating affection, friendship, family, and community care.",
      motifs: ["interlocking heart geometry", "paper-note folds", "ribbon loops"],
      paletteIntent:
        "Cream, berry, plum, rose, and blush provide warmth without gender-coded defaults.",
      shapeLanguage:
        "Folded-paper diamonds, linked curves, and hand-cut edges support a personal but organized feel.",
      texture:
        "Subtle paper fiber and stitch-like borders add craft character while semantic areas stay fully opaque.",
      motionCharacter:
        "A brief linked-shape settle may decorate success, while reduced motion presents the final state directly.",
      originalDirection:
        "Use original inclusive paper-craft forms rather than branded cards, mascots, or romantic clichés.",
      avoid: [
        "Gender assumptions, couple-only language, body stereotypes, or humiliating rejection imagery",
      ],
    },
  }),
  defineTheme({
    id: "birthday",
    name: "Birthday",
    palette: {
      canvas: "#f7f5fc",
      surface: "#ffffff",
      surfaceElevated: "#ebe6f5",
      ink: "#28253f",
      mutedInk: "#514d68",
      primary: "#3a3278",
      primaryText: WHITE,
      secondary: "#0e606a",
      secondaryText: WHITE,
      accent: "#e68a42",
      accentText: "#28253f",
    },
    moodboard: {
      atmosphere:
        "An age-neutral shared celebration with bright anticipation, generosity, and no spotlight pressure.",
      motifs: ["confetti geometry", "streamer curves", "gift and candle blocks"],
      paletteIntent:
        "Soft cream, indigo, turquoise, coral-orange, and violet feel energetic while remaining composed.",
      shapeLanguage:
        "Scattered small accents orbit strong panels, with rounded gift forms and tall candle-like dividers.",
      texture:
        "Paper confetti and ribbon strokes remain sparse, static-capable, and outside all essential reading surfaces.",
      motionCharacter:
        "One contained confetti release may decorate a result, with no looping and an immediate static fallback.",
      originalDirection:
        "Create original general celebration graphics that work across ages, families, and traditions.",
      avoid: [
        "Age jokes, alcohol assumptions, branded party characters, or attention-demanding loss scenes",
      ],
    },
  }),
] as const satisfies readonly ThemeDefinition[];

export type CatalogThemeId = (typeof themeCatalog)[number]["id"];

export function getTheme(id: string): ThemeDefinition | undefined {
  return themeCatalog.find((theme) => theme.id === id);
}

export const themeAccessibilityPolicy = {
  highContrast: {
    prefersContrast: "more",
    forcedColors: "system-colors",
    borderWidthPx: 3,
    underlineLinks: true,
    removeDecorations: true,
    stateMarkers: ["text", "glyph", "border-style"],
  },
  reducedMotion: {
    mediaQuery: "prefers-reduced-motion: reduce",
    transitionDurationMs: 0,
    decorativeMotion: "none",
    showFinalStateImmediately: true,
    preserveLiveAnnouncements: true,
  },
} as const;
