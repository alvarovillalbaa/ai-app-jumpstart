"use client";

import { RouteError } from "@/app/_components/route-error";

export default function WorkspaceError({ retry }: { retry: () => void }) {
  return <RouteError retry={retry} />;
}
