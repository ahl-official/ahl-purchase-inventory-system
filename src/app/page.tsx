"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RootRedirect() {
  const router = useRouter();

  useEffect(() => {
    // Middleware normally routes signed-in users to their role landing page.
    // This is only the fallback for when it does not run.
    router.replace("/login");
  }, [router]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <span
        aria-hidden
        className="grid size-11 place-items-center rounded-xl bg-primary text-sm font-bold tracking-tight text-primary-foreground"
      >
        AHL
      </span>
      <p className="text-sm text-muted-foreground" role="status">
        Opening your workspace…
      </p>
    </div>
  );
}
