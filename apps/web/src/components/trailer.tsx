"use client";

import { useState } from "react";

/** The SPOILS trailer on YouTube (unlisted; embeds still work). */
export const TRAILER_YOUTUBE_ID = "MunQ4wpESBk";

/**
 * Click-to-play YouTube embed: shows the video thumbnail with a play button and only loads the
 * player iframe (youtube-nocookie, no tracking cookies until play) after the click, so the landing
 * page stays light.
 */
export function Trailer({ id = TRAILER_YOUTUBE_ID, title = "SPOILS trailer" }: { id?: string; title?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="toon-panel relative aspect-video w-full overflow-hidden bg-black p-0">
      {playing ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play the ${title}`}
          className="group absolute inset-0 h-full w-full"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail, no optimizer */}
          <img
            src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span className="absolute inset-0 bg-black/25 transition-colors group-hover:bg-black/10" aria-hidden />
          <span className="absolute left-1/2 top-1/2 grid h-20 w-28 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl border-[4px] border-black bg-zooa-lime shadow-[0_6px_0_#000] transition-transform group-hover:scale-110 group-active:translate-y-[calc(-50%+3px)] md:h-24 md:w-36">
            <svg viewBox="0 0 24 24" className="ml-1 h-10 w-10 fill-black md:h-12 md:w-12" aria-hidden>
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          </span>
          <span className="toon-text-thin absolute bottom-3 left-4 text-lg tracking-wide text-white drop-shadow-[0_2px_0_#000] md:text-2xl">
            Watch the trailer
          </span>
        </button>
      )}
    </div>
  );
}
