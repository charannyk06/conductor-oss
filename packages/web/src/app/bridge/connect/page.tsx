"use client";

import { useState } from "react";

export default function BridgeConnectPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setStatus("connecting");
    setErrorMessage("");

    try {
      const res = await fetch("/api/bridge/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });

      if (res.ok) {
        setStatus("success");
      } else {
        const data = await res.json().catch(() => ({}));
        setStatus("error");
        setErrorMessage(data.error || `Connection failed (${res.status})`);
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to connect");
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="border border-white/10 rounded-xl bg-[#111113] p-8">
          <h1 className="text-2xl font-bold text-white mb-2">Connect your laptop</h1>
          <p className="text-white/50 text-sm mb-6">
            Connect a local bridge to access your development environment from anywhere.
          </p>

          <div className="bg-[#0d0d0f] border border-white/5 rounded-lg p-4 mb-6">
            <p className="text-white/40 text-xs mb-2 font-mono">Step 1 — Start the bridge</p>
            <code className="text-white/70 text-sm">
              conductor bridge connect --relay ws://localhost:8080
            </code>
          </div>

          <div className="bg-[#0d0d0f] border border-white/5 rounded-lg p-4 mb-6">
            <p className="text-white/40 text-xs mb-2 font-mono">Step 2 — Paste the token</p>
            <p className="text-white/50 text-xs">
              Copy the token from your terminal and paste it below. The token expires in 5 minutes.
            </p>
          </div>

          <form onSubmit={handleConnect} className="space-y-4">
            <div>
              <textarea
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your bridge token here..."
                className="w-full bg-[#0d0d0f] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none font-mono"
                rows={4}
                disabled={status === "connecting"}
              />
            </div>

            {errorMessage && (
              <p className="text-red-400 text-xs">{errorMessage}</p>
            )}

            {status === "success" ? (
              <div className="flex items-center gap-2 text-emerald-400 text-sm">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                Connected! Your laptop is now linked to this dashboard.
              </div>
            ) : (
              <button
                type="submit"
                disabled={status === "connecting" || !token.trim()}
                className="w-full bg-white text-black font-medium py-3 rounded-lg text-sm hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === "connecting" ? "Connecting..." : "Connect"}
              </button>
            )}
          </form>

          <div className="mt-6 pt-6 border-t border-white/5">
            <p className="text-white/30 text-xs">
              Your data never leaves your laptop. The relay only passes encrypted bytes between your bridge and this dashboard.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
