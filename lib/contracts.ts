export const permissionLevels = ["VIEW", "COMMENT", "EDIT"] as const;
export type PermissionLevelValue = (typeof permissionLevels)[number];

export const threadStatuses = ["OPEN", "RESOLVED"] as const;
export type ThreadStatusValue = (typeof threadStatuses)[number];
