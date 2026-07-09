// Client-side helper for skill uploads. FormData does not carry a File's
// webkitRelativePath, so each file is appended alongside an explicit `paths`
// entry the server reads back in order (see readSkillUploadFromFormData).
export function buildSkillFormData(files: File[], extra: Record<string, string> = {}) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
    formData.append("paths", (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
  }
  for (const [key, value] of Object.entries(extra)) {
    formData.append(key, value);
  }
  return formData;
}
