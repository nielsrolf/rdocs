// Re-export of the GitHub auth resolution, which lives in user-credentials.ts
// next to the AI-credential resolution it mirrors (and to avoid an import
// cycle: the resolver needs getUserCredential, and loadAgentEnvForDocument
// needs the resolver).
export {
  resolveGithubAuthForDocument,
  resolveGithubAuthForUser,
  type GithubAuth,
  type GithubAuthSource
} from "@/lib/user-credentials";
