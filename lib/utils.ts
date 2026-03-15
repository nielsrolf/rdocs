import { PermissionLevelValue } from "@/lib/contracts";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function permissionLabel(permission: PermissionLevelValue | string) {
  switch (permission) {
    case "EDIT":
      return "Can edit";
    case "COMMENT":
      return "Can comment";
    case "VIEW":
    default:
      return "View only";
  }
}

export function isCommentCapable(permission: PermissionLevelValue | string) {
  return permission === "EDIT" || permission === "COMMENT";
}

export function isEditCapable(permission: PermissionLevelValue | string) {
  return permission === "EDIT";
}

export function truncate(value: string, length = 140) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1)}…`;
}
