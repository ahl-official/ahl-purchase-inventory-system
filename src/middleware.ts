import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const { nextUrl } = req;
  const isAuthRoute = nextUrl.pathname === "/login";

  if (isAuthRoute) {
    if (isLoggedIn) {
      return NextResponse.redirect(new URL("/", nextUrl));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    let from = nextUrl.pathname;
    if (nextUrl.search) {
      from += nextUrl.search;
    }
    return NextResponse.redirect(
      new URL(`/login?from=${encodeURIComponent(from)}`, nextUrl)
    );
  }

  const role = req.auth?.user?.role;
  const path = nextUrl.pathname;

  // Role-based routing enforcement
  if (path === "/") {
    if (role === "ProductDistributor") {
      return NextResponse.redirect(new URL("/stock-out", nextUrl));
    }
    if (role === "PurchaseCoordinator") {
      return NextResponse.redirect(new URL("/purchase", nextUrl));
    }
    if (role === "Admin") {
      return NextResponse.redirect(new URL("/admin", nextUrl));
    }
  }

  // Prevent cross-role access
  if (path.startsWith("/stock-out") && role !== "ProductDistributor" && role !== "Admin") {
    return NextResponse.redirect(new URL("/", nextUrl));
  }
  if (path.startsWith("/purchase") && role !== "PurchaseCoordinator" && role !== "Admin") {
    return NextResponse.redirect(new URL("/", nextUrl));
  }
  if (path.startsWith("/admin") && role !== "Admin") {
    return NextResponse.redirect(new URL("/", nextUrl));
  }
  // Dashboard is the one screen Satvik and Hitesh share -- both roles (and
  // Admin) can see it; every other route above stays exclusive to its role.

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
