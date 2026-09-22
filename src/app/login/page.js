"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // null = still loading. The two bootstrap states below are the only way this
  // page can be reached without a usable password, and neither is fixable from
  // here — so tell the operator what to do instead of looping "Invalid
  // password" (there is no default password any more; see
  // lib/auth/dashboardSession).
  const [status, setStatus] = useState(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setStatus(data || {}))
      .catch(() => setStatus({}));
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const needsLocalSetup = status?.needsLocalSetup === true;
  const bootstrapLocal = status?.bootstrapLocal === true;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">10Router</h1>
          <p className="text-text-muted">Enter your password to access the dashboard</p>
        </div>

        <Card>
          {needsLocalSetup ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">No dashboard password is set yet</p>
              <p className="text-xs text-text-muted">
                Remote access to the dashboard stays disabled until a password is set. Set the first
                password on the machine running 10Router (open http://127.0.0.1:20128 there), or start
                it with the INITIAL_PASSWORD environment variable.
              </p>
            </div>
          ) : bootstrapLocal ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">No dashboard password is set yet</p>
              <p className="text-xs text-text-muted">
                Only this machine can open the dashboard until one is set. Set a password on the
                Settings page and LAN access turns back on.
              </p>
              <Button
                type="button"
                variant="primary"
                className="w-full"
                onClick={() => router.push("/dashboard")}
              >
                Open dashboard
              </Button>
            </div>
          ) : (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Password</label>
                <Input
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full"
                isLoading={loading}
              >
                Login
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
