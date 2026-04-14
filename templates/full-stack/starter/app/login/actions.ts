"use server";

import { redirect } from "next/navigation";

import { clearSession, loginWithEmailPassword } from "@/lib/session";

export async function authenticate(formData: FormData) {
  const email = String(formData.get("email") || "");
  const password = String(formData.get("password") || "");

  await loginWithEmailPassword(email, password);
  redirect("/");
}

export async function logout() {
  await clearSession();
  redirect("/login");
}
