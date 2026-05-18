function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeSourceLinks(sourceLinks: string[]) {
  const unique = new Set<string>();

  sourceLinks.forEach((link) => {
    const trimmed = link.trim();
    if (!trimmed || !isHttpUrl(trimmed)) {
      return;
    }

    unique.add(trimmed);
  });

  return Array.from(unique);
}

export function serializeSourceLinks(sourceLinks: string[]) {
  const normalized = normalizeSourceLinks(sourceLinks);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function parseSourceLinks(raw: string | null | undefined) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? normalizeSourceLinks(parsed.filter((value): value is string => typeof value === "string"))
      : [];
  } catch {
    return [];
  }
}

export function getSourceLabel(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return sourceUrl;
  }
}
