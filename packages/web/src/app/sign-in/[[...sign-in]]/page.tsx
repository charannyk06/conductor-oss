import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="surface-card rounded-[var(--radius-lg)] border p-3 shadow-[var(--shadow-card)]">
        <SignIn routing="path" path="/sign-in" />
      </div>
    </main>
  );
}
