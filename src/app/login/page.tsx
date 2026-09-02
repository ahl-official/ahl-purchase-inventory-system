"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  TextInput,
  StatusBanner,
} from "@/components/ui/field";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (res?.error) {
        setError("That email and password combination was not recognised.");
        setLoading(false);
        return;
      }
      // A hard reload, deliberately. The freshly issued session cookie has to be
      // present on a full document request for middleware to route by role; a
      // client-side push can race the cookie and bounce the user back to /login.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/";
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <span
              aria-hidden
              className="mb-4 grid size-11 place-items-center rounded-xl bg-primary text-sm font-bold tracking-tight text-primary-foreground"
            >
              AHL
            </span>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Sign in to AHL Flow
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Inventory and purchasing for American Hair Line
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
            <form onSubmit={handleSubmit} className="space-y-5">
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <TextInput
                  id="email"
                  type="email"
                  required
                  autoComplete="username"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@ahl.com"
                  disabled={loading}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <TextInput
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </Field>

              {error && (
                <StatusBanner tone="error" title="Sign in failed">
                  {error}
                </StatusBanner>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={loading}
                className="h-11 w-full text-[0.9375rem] font-semibold"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </div>

          {/*
            Development convenience only. Seeded credentials must never render
            in a production build.
          */}
          {process.env.NODE_ENV === "development" && (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-3">
              <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Development accounts
              </p>
              <dl className="space-y-1 text-xs text-muted-foreground">
                {[
                  ["Management", "admin@ahl.com"],
                  ["Purchase", "satvik@ahl.com"],
                  ["Distribution", "hitesh@ahl.com"],
                ].map(([role, mail]) => (
                  <div key={mail} className="flex justify-between gap-4">
                    <dt>{role}</dt>
                    <dd>
                      <button
                        type="button"
                        onClick={() => {
                          setEmail(mail);
                          setPassword("");
                        }}
                        className="id-text text-brand underline-offset-2 hover:underline"
                      >
                        {mail}
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
