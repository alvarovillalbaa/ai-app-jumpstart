export const appConfig = {
  id: "ai-app-jumpstart",
  name: "AI App Jumpstart",
  description: "A portable foundation for AI applications, with shared data access and reusable tests.",
  navigation: [
    { href: "/records", label: "Records", feature: "core" },
    { href: "/uploads", label: "Uploads", feature: "uploads" },
    { href: "/s", label: "Chat", feature: "chat" },
    { href: "/conversations", label: "Conversations", feature: "auth" },
    { href: "/structured", label: "Structured output", feature: "chat" },
    { href: "/artifacts", label: "Artifacts", feature: "auth" },
    { href: "/usage", label: "AI usage", feature: "auth" },
    { href: "/account", label: "Account", feature: "auth" },
  ],
} as const;
