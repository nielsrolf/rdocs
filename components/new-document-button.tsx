"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewDocumentButton() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    setIsCreating(true);
    const response = await fetch("/api/documents", {
      method: "POST"
    });

    const data = await response.json().catch(() => null);

    if (response.ok && data?.id) {
      router.push(`/documents/${data.id}`);
      router.refresh();
      return;
    }

    setIsCreating(false);
  }

  return (
    <button
      className="primary-button"
      data-tour="new-doc"
      disabled={isCreating}
      onClick={handleCreate}
      type="button"
    >
      {isCreating ? "Creating..." : "New document"}
    </button>
  );
}
