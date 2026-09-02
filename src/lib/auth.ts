import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Admin
        if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
          return { id: "1", name: "Management", email, role: "Admin", branchId: "HO" };
        }
        
        // Purchase Coordinator (Satvik)
        if (email === process.env.PURCHASE_EMAIL && password === process.env.PURCHASE_PASSWORD) {
          return { id: "2", name: "Satvik", email, role: "PurchaseCoordinator", branchId: "HO" };
        }

        // Floor Distributor (Hitesh)
        if (email === process.env.DISTRIBUTOR_EMAIL && password === process.env.DISTRIBUTOR_PASSWORD) {
          return { id: "3", name: "Hitesh", email, role: "ProductDistributor", branchId: "HO" };
        }

        return null; // Invalid credentials
      },
    }),
  ],
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
});
