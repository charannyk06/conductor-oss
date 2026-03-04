"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

interface FileDiff {
  filename: string;
  additions: number;
  deletions: number;
  status?: string;
}

interface SessionDiffProps {
  sessionId: string;
}

export function SessionDiff({ sessionId }: SessionDiffProps) {
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchDiff = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/diff`);
      if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
      const data = (await res.json()) as { files?: FileDiff[] };
      if (mountedRef.current) {
        setFiles(data.files ?? []);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load diff");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchDiff();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchDiff]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-[13px] text-[var(--color-text-muted)]">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 text-[13px] text-[var(--color-status-error)]">
        {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <FileCode className="h-8 w-8 text-[var(--color-text-muted)]" />
        <p className="text-[13px] text-[var(--color-text-muted)]">No files changed</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      {files.map((file) => (
        <Card key={file.filename}>
          <CardContent className="flex items-center gap-3 py-2.5">
            <FileCode className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            <span className="flex-1 truncate font-mono text-[12px] text-[var(--color-text-primary)]">
              {file.filename}
            </span>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              {file.additions > 0 && (
                <span className="text-emerald-500">+{file.additions}</span>
              )}
              {file.deletions > 0 && (
                <span className="text-red-500">-{file.deletions}</span>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
