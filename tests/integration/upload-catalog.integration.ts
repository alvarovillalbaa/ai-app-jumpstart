import { uploadCatalogContract } from "../contracts/upload-catalog";
import { createUploadCatalog } from "../../lib/uploads/catalog-store";

if (!["postgres","supabase","convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use an explicitly configured disposable database.");
uploadCatalogContract(process.env.DATA_PROVIDER!,createUploadCatalog);
