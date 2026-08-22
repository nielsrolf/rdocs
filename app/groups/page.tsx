import { redirect } from "next/navigation";

// Group management moved into the settings screen. Keep old bookmarks and
// in-app links working.
export default function GroupsPage() {
  redirect("/settings/groups");
}
