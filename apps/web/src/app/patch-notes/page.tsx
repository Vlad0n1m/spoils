import { permanentRedirect } from "next/navigation";

/** /patch-notes is an alias of the public /news page (308, so old links and bookmarks keep working). */
export default function PatchNotesRedirect(): never {
  permanentRedirect("/news");
}
