"use client";

/** Build-time flag — set NEXT_PUBLIC_GUEST_PLAY=1 in .env */
export const guestPlayUiEnabled =
  process.env.NEXT_PUBLIC_GUEST_PLAY === "1";
