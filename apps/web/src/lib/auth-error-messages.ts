const MAP: Record<string, string> = {
  invalid_credentials: "Invalid email or password",
  email_taken: "That email is already taken",
  nickname_taken: "That nickname is already taken",
  already_logged_in: "You are already signed in",
  bad_body: "Check the form and try again",
  create_failed: "Could not create account",
  request_failed: "Something went wrong",
  rate_limited: "Too many attempts. Wait a few minutes and try again",
  busy: "The server is busy. Try again in a moment",
  guest_play_disabled: "Guest play is off. Create an account to play",
  cross_site: "Request blocked. Reload the page and try again",
  unsupported_media_type: "Request blocked. Reload the page and try again",
};

export function authErrorMessage(code: string | undefined): string {
  if (!code) return "Something went wrong";
  return MAP[code] ?? code;
}
