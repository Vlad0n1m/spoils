import { Suspense } from "react";
import type { Metadata } from "next";
import { RegisterForm } from "@/components/register-form";

export const metadata: Metadata = {
  title: "Register — ZOOA",
};

function RegisterFallback() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-16 md:px-6">
      <div className="h-48 rounded-[2rem] border border-white/5 bg-white/[0.02] animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<RegisterFallback />}>
      <RegisterForm />
    </Suspense>
  );
}
