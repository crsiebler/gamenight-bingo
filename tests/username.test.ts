import { describe, expect, test } from "vitest";

import { normalizeUsername } from "../packages/domain/src/index.js";

describe("username normalization", () => {
  test("preserves display casing while collapsing and trimming Unicode whitespace", () => {
    expect(normalizeUsername("  Élodie\u2003\u2003van  Dyke  ")).toEqual({
      ok: true,
      username: "Élodie van Dyke",
      normalizedUsername: "élodie van dyke",
    });
  });

  test("uses Unicode lowercase behavior for uniqueness", () => {
    expect(normalizeUsername("ΟΣ")).toEqual({
      ok: true,
      username: "ΟΣ",
      normalizedUsername: "ος",
    });
  });

  test("uses canonical Unicode forms for display and uniqueness", () => {
    expect(normalizeUsername("Jose\u0301")).toEqual({
      ok: true,
      username: "José",
      normalizedUsername: "josé",
    });
  });

  test("rejects a name that is empty after whitespace normalization", () => {
    expect(normalizeUsername(" \u2003  ")).toEqual({
      ok: false,
      error: {
        code: "USERNAME_EMPTY",
        message: "Enter a username.",
      },
    });
  });

  test("rejects every Unicode control character", () => {
    const controlCharacters = [
      ...Array.from({ length: 32 }, (_, codePoint) => String.fromCodePoint(codePoint)),
      String.fromCodePoint(127),
      ...Array.from({ length: 32 }, (_, index) => String.fromCodePoint(128 + index)),
    ];

    for (const controlCharacter of controlCharacters) {
      expect(normalizeUsername(`Player${controlCharacter}Name`)).toEqual({
        ok: false,
        error: {
          code: "USERNAME_CONTROL_CHARACTER",
          message: "Usernames cannot contain control characters.",
        },
      });
    }
  });

  test("rejects invisible Unicode format controls", () => {
    for (const formatControl of ["\u200B", "\u200D", "\u202E", "\u2066", "\uFEFF"]) {
      expect(normalizeUsername(`Player${formatControl}Name`)).toEqual({
        ok: false,
        error: {
          code: "USERNAME_CONTROL_CHARACTER",
          message: "Usernames cannot contain control characters.",
        },
      });
    }
  });

  test("rejects display or lowercase forms longer than the persistence limit", () => {
    for (const username of ["A".repeat(129), "İ".repeat(65)]) {
      expect(normalizeUsername(username)).toEqual({
        ok: false,
        error: {
          code: "USERNAME_TOO_LONG",
          message: "Usernames must be 128 characters or fewer.",
        },
      });
    }
  });
});
