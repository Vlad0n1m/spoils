/** Avoid "Unexpected end of JSON input" on HTML/empty error bodies. */
export async function parseJsonResponse<T = unknown>(
  res: Response,
): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Empty response (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Not JSON (HTTP ${res.status}): ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
    );
  }
}
