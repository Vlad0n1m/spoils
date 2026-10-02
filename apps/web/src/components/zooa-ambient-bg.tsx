/** Shared with /play, /wallet — matches landing ZOOA atmosphere. */
export function ZooaAmbientBg() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[min(85dvh,40rem)] min-h-[18rem] bg-[radial-gradient(ellipse_120%_90%_at_50%_-10%,#4a6b1e_0%,#2d4411_22%,#162208_48%,#090b08_78%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 animate-twinkle opacity-[0.16] motion-reduce:animate-none"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 8% 10%, rgba(255,255,255,0.5), transparent), radial-gradient(1px 1px at 32% 24%, rgba(220,255,180,0.35), transparent), radial-gradient(1px 1px at 68% 18%, rgba(255,255,255,0.4), transparent), radial-gradient(1px 1px at 88% 38%, rgba(200,255,160,0.3), transparent), radial-gradient(1.5px 1.5px at 18% 52%, rgba(255,255,255,0.25), transparent)",
          backgroundSize: "100% 100%",
        }}
        aria-hidden
      />
    </>
  );
}
