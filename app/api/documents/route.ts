import { NextResponse } from "next/server";

import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const document = await db.document.create({
    data: {
      ownerId: user.id,
      title: "Untitled document",
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: {
      id: true
    }
  });

  return NextResponse.json({ id: document.id });
}
