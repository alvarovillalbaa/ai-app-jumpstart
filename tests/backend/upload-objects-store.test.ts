import { expect,it } from "vitest";
import { createUploadObjects } from "../../lib/uploads/objects-store";

it("requires explicit persistent blob configuration and refuses local storage on serverless hosts",async () => {
  await expect(createUploadObjects({})).rejects.toMatchObject({ status: 503,code: "upload_storage_unavailable" });
  await expect(createUploadObjects({ UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: "/tmp/private",VERCEL: "1" }))
    .rejects.toMatchObject({ status: 503,code: "upload_storage_unavailable" });
  await expect(createUploadObjects({ UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: "public/uploads" }))
    .rejects.toMatchObject({ status: 503,code: "upload_storage_unavailable" });
  await expect(createUploadObjects({ UPLOAD_STORAGE_PROVIDER: "supabase",SUPABASE_URL: "https://example.test" }))
    .rejects.toMatchObject({ status: 503,code: "upload_storage_unavailable" });
});
