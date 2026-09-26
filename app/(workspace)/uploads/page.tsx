import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { UploadQuarantine } from "@/app/_components/upload-quarantine";
import { currentUser } from "@/lib/auth/server";
import { authSettings } from "@/lib/auth/settings";
import { uploadDownloadConfigured } from "@/lib/uploads/download-capability";

export const metadata = { title: "Uploads" };

export default async function UploadsPage() {
  await connection();
  if (!["local", "supabase"].includes(process.env.UPLOAD_STORAGE_PROVIDER ?? "")) {
    return <main className="p-8"><h1>Uploads are not enabled</h1><p>Configure a private upload storage provider to use this workspace.</p><Link href="/records">Open records</Link></main>;
  }
  const settings = authSettings();
  const downloadEnabled = uploadDownloadConfigured(process.env);
  if (!settings) return <UploadQuarantine downloadEnabled={downloadEnabled} />;
  const user = await currentUser();
  if (!user) redirect("/login?next=/uploads");
  return <UploadQuarantine key={user.id} settings={settings} userId={user.id} downloadEnabled={downloadEnabled} />;
}
