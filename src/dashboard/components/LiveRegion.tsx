import { useAnnouncement } from "../live";

// Always on the page, so a polite announcement is read even though the region didn't just appear.
export function LiveRegion() {
  const said = useAnnouncement();
  return (
    <div className="sr-only" aria-live="polite">
      {said && <span key={said.id}>{said.text}</span>}
    </div>
  );
}
