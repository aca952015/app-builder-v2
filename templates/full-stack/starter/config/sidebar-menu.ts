import sidebarMenu from "./sidebar-menu.json";

export type SidebarLeafItem = {
  label: string;
  path: string;
  icon: string;
};

export type SidebarGroupItem = {
  label: string;
  icon: string;
  children: SidebarLeafItem[];
};

export type SidebarMenuItem = SidebarLeafItem | SidebarGroupItem;

export function isSidebarGroupItem(item: SidebarMenuItem): item is SidebarGroupItem {
  return "children" in item;
}

export function validateSidebarMenu(items: unknown): SidebarMenuItem[] {
  if (!Array.isArray(items)) {
    throw new Error("sidebar-menu.json must export an array.");
  }

  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`sidebar-menu.json item ${index} must be an object.`);
    }

    const record = item as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.icon !== "string") {
      throw new Error(`sidebar-menu.json item ${index} must include string label and icon.`);
    }

    if (Array.isArray(record.children)) {
      const children = record.children.map((child, childIndex) => {
        if (!child || typeof child !== "object") {
          throw new Error(`sidebar-menu.json child ${index}.${childIndex} must be an object.`);
        }

        const childRecord = child as Record<string, unknown>;
        if ("children" in childRecord) {
          throw new Error("sidebar-menu.json supports at most two menu levels.");
        }

        if (
          typeof childRecord.label !== "string" ||
          typeof childRecord.path !== "string" ||
          typeof childRecord.icon !== "string"
        ) {
          throw new Error(`sidebar-menu.json child ${index}.${childIndex} must include label, path, and icon.`);
        }

        return {
          label: childRecord.label,
          path: childRecord.path,
          icon: childRecord.icon,
        };
      });

      return {
        label: record.label,
        icon: record.icon,
        children,
      };
    }

    if (typeof record.path !== "string") {
      throw new Error(`sidebar-menu.json item ${index} must include a path when children are absent.`);
    }

    return {
      label: record.label,
      path: record.path,
      icon: record.icon,
    };
  });
}

export const sidebarMenuItems = validateSidebarMenu(sidebarMenu);
