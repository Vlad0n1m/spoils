const MAP: Record<string, string> = {
  invalid_credentials: "Invalid email or password",
  email_taken: "That email is already taken",
  nickname_taken: "That nickname is already taken",
  already_logged_in: "You are already signed in",
  bad_body: "Check the form and try again",
  create_failed: "Could not create account",
  request_failed: "Something went wrong",
  rate_limited: "Too many sign-in attempts. Wait a few minutes and try again",
  cross_site: "Request blocked. Reload the page and try again",
  unsupported_media_type: "Request blocked. Reload the page and try again",
};

export function authErrorMessage(code: string | undefined): string {
  if (!code) return "Something went wrong";
  return MAP[code] ?? code;
}
