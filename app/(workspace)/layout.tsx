import { connection } from "next/server";
import { WorkspaceNavigation } from "@/app/_components/workspace-navigation";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const accountEnabled = process.env.AUTH_PROVIDER === "supabase";
  const chatEnabled = process.env.AI_CHAT_ENABLED === "true" && accountEnabled;
  const uploadsEnabled = ["local", "supabase"].includes(process.env.UPLOAD_STORAGE_PROVIDER ?? "");
  return <div className="min-h-dvh bg-background md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
    <WorkspaceNavigation accountEnabled={accountEnabled} chatEnabled={chatEnabled} uploadsEnabled={uploadsEnabled} />
    <div id="workspace-content" tabIndex={-1} className="min-w-0 focus-visible:outline-2 focus-visible:outline-ring">{children}</div>
  </div>;
}
