import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Sign in — ${BRAND.name}`,
};

function LoginFallback() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-16 md:px-6">
      <div className="h-40 rounded-[2rem] border border-white/5 bg-white/[0.02] animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}
