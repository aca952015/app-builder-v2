"use client";

import { useEffect, useState } from "react";

import { isSidebarGroupItem, sidebarMenuItems } from "@/config/sidebar-menu";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSidebar } from "@/context/SidebarContext";

function DashboardIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M3 13.2C3 10.2806 3 8.82085 3.3806 7.68386C3.99089 5.86198 5.36198 4.49089 7.18386 3.8806C8.32085 3.5 9.78059 3.5 12.7 3.5H13.3C16.2194 3.5 17.6791 3.5 18.8161 3.8806C20.638 4.49089 22.0091 5.86198 22.6194 7.68386C23 8.82085 23 10.2806 23 13.2V13.8C23 16.7194 23 18.1791 22.6194 19.3161C22.0091 21.138 20.638 22.5091 18.8161 23.1194C17.6791 23.5 16.2194 23.5 13.3 23.5H12.7C9.78059 23.5 8.32085 23.5 7.18386 23.1194C5.36198 22.5091 3.99089 21.138 3.3806 19.3161C3 18.1791 3 16.7194 3 13.8V13.2Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M8 7.75C7.58579 7.75 7.25 8.08579 7.25 8.5V11.5C7.25 11.9142 7.58579 12.25 8 12.25H11C11.4142 12.25 11.75 11.9142 11.75 11.5V8.5C11.75 8.08579 11.4142 7.75 11 7.75H8Z" fill="currentColor" />
      <path d="M13 7.75C12.5858 7.75 12.25 8.08579 12.25 8.5V15.5C12.25 15.9142 12.5858 16.25 13 16.25H16C16.4142 16.25 16.75 15.9142 16.75 15.5V8.5C16.75 8.08579 16.4142 7.75 16 7.75H13Z" fill="currentColor" />
      <path d="M8 13.75C7.58579 13.75 7.25 14.0858 7.25 14.5V17.5C7.25 17.9142 7.58579 18.25 8 18.25H11C11.4142 18.25 11.75 17.9142 11.75 17.5V14.5C11.75 14.0858 11.4142 13.75 11 13.75H8Z" fill="currentColor" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.4858 3.5L13.5182 3.5C13.9233 3.5 14.2518 3.82851 14.2518 4.23377C14.2518 5.9529 16.1129 7.02795 17.602 6.1682C17.9528 5.96567 18.4014 6.08586 18.6039 6.43667L20.1203 9.0631C20.3229 9.41407 20.2027 9.86286 19.8517 10.0655C18.3625 10.9253 18.3625 13.0747 19.8517 13.9345C20.2026 14.1372 20.3229 14.5859 20.1203 14.9369L18.6039 17.5634C18.4013 17.9142 17.9528 18.0344 17.602 17.8318C16.1129 16.9721 14.2518 18.0471 14.2518 19.7663C14.2518 20.1715 13.9233 20.5 13.5182 20.5H10.4858C10.0804 20.5 9.75182 20.1714 9.75182 19.766C9.75182 18.0461 7.88983 16.9717 6.40067 17.8314C6.04945 18.0342 5.60037 17.9139 5.39767 17.5628L3.88167 14.937C3.67903 14.586 3.79928 14.1372 4.15026 13.9346C5.63949 13.0748 5.63946 10.9253 4.15025 10.0655C3.79926 9.86282 3.67901 9.41401 3.88165 9.06303L5.39764 6.43725C5.60034 6.08617 6.04943 5.96581 6.40065 6.16858C7.88982 7.02836 9.75182 5.9539 9.75182 4.23399C9.75182 3.82862 10.0804 3.5 10.4858 3.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 7.8C4 6.11984 4 5.27976 4.32698 4.63803C4.6146 4.07354 5.07354 3.6146 5.63803 3.32698C6.27976 3 7.11984 3 8.8 3H9.40923C10.1721 3 10.5535 3 10.9137 3.10822C11.2331 3.20416 11.5349 3.35045 11.8076 3.54102C12.1152 3.75606 12.3562 4.04703 12.8381 4.62897L13.162 5.01941C13.6438 5.60135 13.8848 5.89232 14.1924 6.10736C14.4651 6.29792 14.7669 6.44422 15.0863 6.54015C15.4465 6.64838 15.8279 6.64838 16.5908 6.64838C18.1792 6.64838 18.9735 6.64838 19.6003 6.95752C20.1518 7.22951 20.6005 7.67827 20.8725 8.22975C21.1816 8.85656 21.1816 9.65081 21.1816 11.2392V14.2C21.1816 16.8802 21.1816 18.2203 20.6601 19.2449C20.2014 20.1451 19.4699 20.8765 18.5698 21.3352C17.5452 21.8568 16.2051 21.8568 13.5249 21.8568H10.4751C7.79491 21.8568 6.45481 21.8568 5.43022 21.3352C4.53007 20.8765 3.79862 20.1451 3.33991 19.2449C2.81836 18.2203 2.81836 16.8802 2.81836 14.2V8.98162C2.81836 8.52964 2.81836 8.30365 2.89485 8.12584C2.96131 7.97133 3.06718 7.83691 3.20191 7.73619C3.35704 7.62021 3.57567 7.58162 4.01294 7.50443L4 7.8Z"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path
        d="M7.75 12.25C7.33579 12.25 7 12.5858 7 13C7 13.4142 7.33579 13.75 7.75 13.75H16.25C16.6642 13.75 17 13.4142 17 13C17 12.5858 16.6642 12.25 16.25 12.25H7.75ZM7.75 16.25C7.33579 16.25 7 16.5858 7 17C7 17.4142 7.33579 17.75 7.75 17.75H12.25C12.6642 17.75 13 17.4142 13 17C13 16.5858 12.6642 16.25 12.25 16.25H7.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function GenericItemIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M6.75 5.75C5.64543 5.75 4.75 6.64543 4.75 7.75V16.25C4.75 17.3546 5.64543 18.25 6.75 18.25H17.25C18.3546 18.25 19.25 17.3546 19.25 16.25V7.75C19.25 6.64543 18.3546 5.75 17.25 5.75H6.75Z"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path
        d="M8 10.25C8 9.83579 8.33579 9.5 8.75 9.5H15.25C15.6642 9.5 16 9.83579 16 10.25C16 10.6642 15.6642 11 15.25 11H8.75C8.33579 11 8 10.6642 8 10.25ZM8.75 13C8.33579 13 8 13.3358 8 13.75C8 14.1642 8.33579 14.5 8.75 14.5H12.75C13.1642 14.5 13.5 14.1642 13.5 13.75C13.5 13.3358 13.1642 13 12.75 13H8.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`ml-auto h-5 w-5 transition-transform duration-200 ${open ? "rotate-180 text-brand-500 dark:text-brand-400" : "text-gray-500 dark:text-gray-400"}`}
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M5 7.5L10 12.5L15 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const iconMap: Record<string, React.ReactNode> = {
  dashboard: <DashboardIcon />,
  settings: <SettingsIcon />,
  workspace: <WorkspaceIcon />,
};

function renderSidebarIcon(icon: string) {
  return iconMap[icon] ?? <GenericItemIcon />;
}

export default function AppSidebar() {
  const pathname = usePathname();
  const { isExpanded, isMobileOpen, isHovered, setIsHovered } = useSidebar();
  const [mounted, setMounted] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const activeGroup = sidebarMenuItems.find((item) =>
      isSidebarGroupItem(item) ? item.children.some((child) => child.path === pathname) : false,
    );
    setOpenGroup(activeGroup && isSidebarGroupItem(activeGroup) ? activeGroup.label : null);
  }, [pathname]);

  const expanded = isExpanded || isHovered || isMobileOpen;

  return (
    <aside
      className={`fixed mt-16 flex flex-col lg:mt-0 top-0 px-5 left-0 bg-white dark:bg-gray-900 dark:border-gray-800 text-gray-900 h-screen transition-all duration-300 ease-in-out z-50 border-r border-gray-200 ${
        expanded ? "w-[290px]" : "w-[90px]"
      } ${isMobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      onMouseEnter={() => !isExpanded && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={`py-8 flex ${expanded ? "justify-start" : "lg:justify-center"}`}>
        <Link href="/" className="block">
          {expanded ? (
            <div>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">TailAdmin Starter</p>
              <p className="text-theme-xs text-gray-500 dark:text-gray-400">Next.js admin shell</p>
            </div>
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500 text-white">T</div>
          )}
        </Link>
      </div>

      <div className="flex flex-col overflow-y-auto duration-300 ease-linear no-scrollbar">
        <nav className="mb-6">
          <div className="flex flex-col gap-4">
            <div>
              {expanded && (
                <h2 className="mb-4 text-xs uppercase flex leading-[20px] text-gray-400">
                  Product workspace
                </h2>
              )}
              <ul className="flex flex-col gap-4">
                {sidebarMenuItems.map((item) => {
                  if (isSidebarGroupItem(item)) {
                    const groupActive = mounted && item.children.some((child) => child.path === pathname);
                    const groupOpen = expanded && openGroup === item.label;

                    return (
                      <li key={item.label}>
                        <button
                          type="button"
                          onClick={() => setOpenGroup((current) => (current === item.label ? null : item.label))}
                          className={`menu-item group w-full ${groupActive ? "menu-item-active" : "menu-item-inactive"} ${
                            expanded ? "lg:justify-start" : "lg:justify-center"
                          }`}
                        >
                          <span className={`menu-item-icon ${groupActive ? "menu-item-icon-active" : "menu-item-icon-inactive"}`}>
                            {renderSidebarIcon(item.icon)}
                          </span>
                          {expanded && (
                            <>
                              <span className="menu-item-text">{item.label}</span>
                              <ChevronIcon open={groupOpen} />
                            </>
                          )}
                        </button>

                        {expanded && groupOpen && (
                          <ul className="mt-2 ml-11 space-y-1">
                            {item.children.map((child) => {
                              const active = mounted && pathname === child.path;
                              return (
                                <li key={child.path}>
                                  <Link
                                    href={child.path}
                                    className={`menu-dropdown-item group ${active ? "menu-dropdown-item-active" : "menu-dropdown-item-inactive"}`}
                                  >
                                    <span className={`menu-item-icon ${active ? "menu-item-icon-active" : "menu-item-icon-inactive"}`}>
                                      {renderSidebarIcon(child.icon)}
                                    </span>
                                    <span>{child.label}</span>
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  }

                  const active = mounted && pathname === item.path;
                  return (
                    <li key={item.path}>
                      <Link
                        href={item.path}
                        className={`menu-item group ${active ? "menu-item-active" : "menu-item-inactive"} ${
                          expanded ? "lg:justify-start" : "lg:justify-center"
                        }`}
                      >
                        <span className={`menu-item-icon ${active ? "menu-item-icon-active" : "menu-item-icon-inactive"}`}>
                          {renderSidebarIcon(item.icon)}
                        </span>
                        {expanded && <span className="menu-item-text">{item.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </nav>

        {expanded && (
          <div className="mt-auto rounded-2xl bg-brand-950 p-5 text-white">
            <p className="text-sm font-semibold">TailAdmin route groups</p>
            <p className="mt-2 text-theme-sm text-white/70">
              The agent should extend this admin shell instead of replacing it with a generic layout.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
