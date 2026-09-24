export const appConfig = {
  name: "AI App Jumpstart",
  description: "A portable foundation for AI applications, with shared data access and reusable tests.",
  navigation: [
    { href: "/records", label: "Records", feature: "core" },
    { href: "/s", label: "Chat", feature: "chat" },
    { href: "/conversations", label: "Conversations", feature: "chat" },
    { href: "/structured", label: "Structured output", feature: "chat" },
    { href: "/artifacts", label: "Artifacts", feature: "chat" },
    { href: "/usage", label: "AI usage", feature: "chat" },
    { href: "/account", label: "Account", feature: "auth" },
  ],
} as const;
