import type { State } from "../../api";
import { EventCard } from "./EventCard";
import { MailCard, type MailActionView } from "./MailCard";

// An email or calendar draft's card, wherever it shows: Needs you, the Inbox space, or under its thread.
export function DraftCard({ approval, action, folded = false }: { approval: State["approvals"][number]; action: MailActionView; folded?: boolean }) {
  return action.event ? <EventCard approval={approval} action={action} folded={folded} /> : <MailCard approval={approval} action={action} folded={folded} />;
}
