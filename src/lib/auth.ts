import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { callAppsScript } from "@/lib/api";
import { authConfig } from "@/lib/auth.config";

interface DatabaseLogin {
  id: string;
  email: string;
  name: string;
  role: "Admin" | "PurchaseCoordinator" | "ProductDistributor";
  branchId: string;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).trim().toLowerCase();
        const password = String(credentials.password);

        const result = await callAppsScript<DatabaseLogin, { email: string; password: string }>({
          action: "auth.login",
          actor: email,
          data: { email, password },
        });

        if (!result.ok) return null;

        return {
          id: result.data.id,
          name: result.data.name,
          email: result.data.email,
          role: result.data.role,
          branchId: result.data.branchId,
        };
      },
    }),
  ],
});
