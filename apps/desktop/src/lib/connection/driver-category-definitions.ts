export const DRIVER_CATEGORIES = [
  { key: "sql", order: 1, titleKey: "connection.databaseCategorySql" },
  { key: "domestic", order: 2, titleKey: "connection.databaseCategoryDomestic" },
] as const;

export type DriverCategoryKey = (typeof DRIVER_CATEGORIES)[number]["key"];

const VALID_CATEGORY_KEYS: ReadonlySet<string> = new Set(DRIVER_CATEGORIES.map((cat) => cat.key));

const EMPTY = 0;

export const AGENT_DRIVER_CATEGORY_MAP: Readonly<Record<string, DriverCategoryKey>> = {
  opengauss: "domestic",
  postgres: "sql",
};

export const getCategoryForAgentDriver = (dbType: string): DriverCategoryKey | "all" => AGENT_DRIVER_CATEGORY_MAP[dbType] ?? "all";

const collectUnmapped = (driverKeys: string[]): string[] => driverKeys.filter((key) => !(key in AGENT_DRIVER_CATEGORY_MAP));

const collectUnknownCategories = (): string[] =>
  Object.entries(AGENT_DRIVER_CATEGORY_MAP)
    .filter(([, category]) => !VALID_CATEGORY_KEYS.has(category))
    .map(([key, category]) => `${key}->${category}`);

const collectDuplicateKeys = (driverKeys: string[]): string[] => driverKeys.filter((key, index) => driverKeys.indexOf(key) !== index).filter((key, index, arr) => arr.indexOf(key) === index);

const formatErrorMessage = (unmapped: string[], unknownCategories: string[], duplicateKeys: string[]): string => {
  const parts: string[] = [];
  if (unmapped.length > EMPTY) {
    parts.push(`unmapped=${unmapped.join(",")}`);
  }
  if (unknownCategories.length > EMPTY) {
    parts.push(`unknownCategories=${unknownCategories.join(",")}`);
  }
  if (duplicateKeys.length > EMPTY) {
    parts.push(`duplicateKeys=${duplicateKeys.join(",")}`);
  }
  return parts.join("; ");
};

export const assertAgentDriverCategoriesComplete = (agentDriverDbTypes: string[]): void => {
  const unmapped = collectUnmapped(agentDriverDbTypes);
  const unknownCategories = collectUnknownCategories();
  const duplicateKeys = collectDuplicateKeys(agentDriverDbTypes);

  if (unmapped.length > EMPTY || unknownCategories.length > EMPTY || duplicateKeys.length > EMPTY) {
    throw new Error(formatErrorMessage(unmapped, unknownCategories, duplicateKeys));
  }
};
