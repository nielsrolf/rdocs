import { redirect } from "next/navigation";

// /settings is a shell: the first section is the AI settings page. Keeps the
// topbar "Settings" link and old bookmarks working while sections live at
// /settings/<section>.
export default function SettingsIndexPage() {
  redirect("/settings/agent");
}
