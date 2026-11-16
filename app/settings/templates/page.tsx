import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/settings-nav";
import { TemplatesSettings } from "@/components/templates-settings";
import { getCurrentUser } from "@/lib/auth";
import { listTemplatesForUser } from "@/lib/templates";

// Templates section of the settings screen: the user's "New document" list.
export default async function TemplatesSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const templates = await listTemplatesForUser(user.id);

  return (
    <main className="slack-connect-shell">
      <div className="settings-page">
        <SettingsNav />
        <div className="slack-connect-card">
          <section className="credentials-section slack-connect-success">
            <strong className="credentials-section-title">Templates</strong>
            <p>
              A template is a document you can start new documents from. To make one, open a document
              you own and choose File → This doc is a template.
            </p>
          </section>
          <TemplatesSettings initialTemplates={templates} />
        </div>
      </div>
    </main>
  );
}
