export type UsernameNormalizationResult =
  | {
      readonly ok: true;
      readonly username: string;
      readonly normalizedUsername: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | {
            readonly code: "USERNAME_EMPTY";
            readonly message: "Enter a username.";
          }
        | {
            readonly code: "USERNAME_CONTROL_CHARACTER";
            readonly message: "Usernames cannot contain control characters.";
          }
        | {
            readonly code: "USERNAME_TOO_LONG";
            readonly message: "Usernames must be 128 characters or fewer.";
          };
    };

export function normalizeUsername(input: string): UsernameNormalizationResult {
  if (/[\p{Cc}\p{Cf}]/u.test(input)) {
    return {
      ok: false,
      error: {
        code: "USERNAME_CONTROL_CHARACTER",
        message: "Usernames cannot contain control characters.",
      },
    };
  }

  const username = input.trim().replace(/\s+/gu, " ").normalize("NFC");
  if (username.length === 0) {
    return {
      ok: false,
      error: {
        code: "USERNAME_EMPTY",
        message: "Enter a username.",
      },
    };
  }

  const normalizedUsername = username.toLowerCase();
  if (username.length > 128 || normalizedUsername.length > 128) {
    return {
      ok: false,
      error: {
        code: "USERNAME_TOO_LONG",
        message: "Usernames must be 128 characters or fewer.",
      },
    };
  }

  return {
    ok: true,
    username,
    normalizedUsername,
  };
}
