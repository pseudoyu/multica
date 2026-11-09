"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LineBindPage } from "@multica/views/line";

// /line/bind?token=<raw> is the bot's "link your account" destination.
// Suspense wraps useSearchParams per Next.js 15's CSR-bailout rule.
function LineBindPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  return <LineBindPage token={token} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LineBindPageContent />
    </Suspense>
  );
}
