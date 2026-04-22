import { logout } from "@/app/login/actions";
import { requireUser } from "@/lib/session";
import AdminShell from "@/layout/AdminShell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  async function logoutAction() {
    "use server";
    await logout();
  }

  return (
    <AdminShell userEmail={user.email} logoutAction={logoutAction}>
      {children}
    </AdminShell>
  );
}
