"use client";

import { RouteError } from "./_components/route-error";

export default function Error({ retry }: { retry: () => void }) {
  return <RouteError retry={retry} />;
}
