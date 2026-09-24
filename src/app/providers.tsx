"use client";

import { SessionProvider } from "next-auth/react";

// useSession() in the app shell needs this to show the signed-in user and role-filtered navigation.
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
