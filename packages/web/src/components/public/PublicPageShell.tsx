"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type PublicPageShellProps = {
  children: ReactNode;
  className?: string;
};

export function PublicPageShell({ children, className }: PublicPageShellProps) {
  return (
    <main className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-strong)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8 sm:px-8 sm:py-10">
        <header className="flex items-center gap-3 border-b border-[var(--border-soft)] pb-6">
          <img
            src="/icon.svg"
            alt="Conductor icon"
            width={40}
            height={40}
            className="h-10 w-10 rounded-[10px] border border-[var(--border-soft)] bg-[var(--bg-panel)] p-1.5"
          />
          <Image
            src="/brand/conductor-wordmark-dark.png"
            alt="Conductor"
            width={320}
            height={62}
            priority
            className="h-auto w-[168px] sm:w-[220px]"
          />
        </header>

        <div className={cn("flex-1 py-10 sm:py-12", className)}>{children}</div>
      </div>
    </main>
  );
}

type PublicPanelProps = {
  children: ReactNode;
  className?: string;
};

export function PublicPanel({ children, className }: PublicPanelProps) {
  return (
    <section
      className={cn(
        "surface-card rounded-[var(--radius-lg)] border border-[var(--border-soft)] bg-[var(--bg-panel)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

type PublicSectionProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
};

export function PublicSection({
  eyebrow,
  title,
  description,
  children,
  className,
}: PublicSectionProps) {
  return (
    <div className={cn("space-y-4", className)}>
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">{eyebrow}</p>
      ) : null}
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-[var(--text-strong)] sm:text-4xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-base leading-7 text-[var(--text-muted)] sm:text-lg">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
