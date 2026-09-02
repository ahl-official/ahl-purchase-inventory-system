import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe session configuration shared with middleware.
 * Credential verification stays in auth.ts because it uses the Node runtime.
 */
export const authConfig = {
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // @ts-expect-error - role/branchId are augmented on User in src/types/next-auth.d.ts
        token.role = user.role;
        // @ts-expect-error - role/branchId are augmented on User in src/types/next-auth.d.ts
        token.branchId = user.branchId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.role = token.role as string;
        session.user.branchId = token.branchId as string;
      }
      return session;
    },
  },
  session: {
    strategy: "jwt",
  },
} satisfies NextAuthConfig;
