"use client";

import { useEffect, useState } from "react";
import { IDOS_BUILD, isIdosFramed } from "@/lib/edition";

/**
 * True when the iDos Games edition runs inside a frame (the idosgames.com page or the iDos shell).
 * Read after mount, so the server render and the first client render match. In the main build
 * IDOS_BUILD is a build-time false and this hook never changes state.
 */
export function useIdosFramed(): boolean {
  const [framed, setFramed] = useState(false);
  useEffect(() => {
    if (IDOS_BUILD) setFramed(isIdosFramed());
  }, []);
  return framed;
}
