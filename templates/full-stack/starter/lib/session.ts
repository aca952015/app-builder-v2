import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

const COOKIE_NAME = "app_builder_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) {
    return false;
  }

  const digest = hashPassword(password, salt);
  return timingSafeEqual(Buffer.from(digest), Buffer.from(expected));
}

function sign(payload: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required.");
  }

  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function readSession() {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) {
    return null;
  }

  const [payload, signature] = raw.split(".");
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = sign(payload);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    userId: string;
    exp: number;
  };

  if (Date.now() > decoded.exp) {
    return null;
  }

  return decoded;
}

async function writeSession(userId: string) {
  const store = await cookies();
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      exp: Date.now() + SESSION_TTL_MS,
    }),
  ).toString("base64url");

  const signature = sign(payload);
  store.set(COOKIE_NAME, payload + "." + signature, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function loginWithEmailPassword(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error("Invalid email or password.");
  }

  await writeSession(user.id);
  return user;
}

export async function clearSession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getCurrentUser() {
  const session = await readSession();
  if (!session) {
    return null;
  }

  return prisma.user.findUnique({
    where: { id: session.userId },
  });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
