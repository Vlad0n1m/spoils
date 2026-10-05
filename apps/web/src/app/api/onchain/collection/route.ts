import { SITE_URL } from "@/lib/site-url";

/** Metaplex JSON metadata of the SPOILS Items collection (the collection's uri). */
export function GET(req: Request) {
  const origin = SITE_URL?.origin ?? new URL(req.url).origin;
  return Response.json(
    {
      name: "SPOILS Items",
      symbol: "SPOILS",
      description: "Weapons and gear extracted from raids in SPOILS. Trade them for SOL or bring them back into the game.",
      image: `${origin}/icon-512.png`,
      external_url: `${origin}/onchain`,
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
