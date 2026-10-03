"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** Art paths that failed once in this page load: later mounts go straight to the fallback. */
const failed = new Set<string>();

/**
 * Menu art with a sprite fallback (WORLD v6 spec §6.6: the menu ships before the lobby art of step
 * S10 exists). Tries `src`; on a load error (also one that happened before hydration) it switches
 * to `fallback` and applies `fallbackClassName`. Static files, plain <img> like the rest of the UI.
 */
export function FallbackImg({
  src,
  fallback,
  alt = "",
  className,
  fallbackClassName,
  style,
}: {
  src: string;
  fallback: string;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  style?: React.CSSProperties;
}) {
  const [cur, setCur] = useState(() => (failed.has(src) ? fallback : src));
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setCur(failed.has(src) ? fallback : src);
  }, [src, fallback]);

  const fail = () => {
    if (cur === fallback) return;
    failed.add(src);
    setCur(fallback);
  };

  // An error fired before React attached onError (server-rendered <img>) leaves a broken image.
  useEffect(() => {
    const img = ref.current;
    if (img && cur !== fallback && img.complete && img.naturalWidth === 0) fail();
  });

  const onFallback = cur === fallback && cur !== src;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- small static menu art
    <img
      ref={ref}
      src={cur}
      alt={alt}
      onError={fail}
      decoding="async"
      draggable={false}
      style={style}
      className={clsx("pointer-events-none select-none", className, onFallback && fallbackClassName)}
    />
  );
}
