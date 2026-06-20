import { GALAXY_RULES, ITEM_RULES, MODE_RULES, THREE_PART_ITEMS, TWO_PART_ITEMS } from "./flair-rules.js";

export type FlairValidationResult = {
  valid: boolean;
  normalizedText: string;
  reasons: string[];
};

function matchFirst(input: string, rules: Array<[string, string]>): string {
  let matched = "";
  for (const [pattern, value] of rules) {
    if (new RegExp(pattern, "i").test(input)) {
      matched = value;
    }
  }
  return matched;
}

export function validateEditableFlair(
  flairText: string | undefined,
  sourceText: string | undefined,
): FlairValidationResult {
  const flair = flairText ?? "";
  const source = sourceText ?? "";

  const flairItem = matchFirst(flair, ITEM_RULES);
  let flairGalaxy = matchFirst(flair, GALAXY_RULES);
  let flairMode = matchFirst(flair, MODE_RULES);

  if (!flairGalaxy) {
    flairGalaxy = matchFirst(source, GALAXY_RULES);
  }

  if (THREE_PART_ITEMS.has(flairItem) && !flairMode) {
    flairMode = matchFirst(source, MODE_RULES);
  }

  let normalizedText = "";
  let valid = false;

  if (flairItem && flairGalaxy) {
    if (TWO_PART_ITEMS.has(flairItem)) {
      normalizedText = `${flairItem}/${flairGalaxy}`;
      valid = true;
    }

    if (THREE_PART_ITEMS.has(flairItem) && flairMode) {
      normalizedText = `${flairItem}/${flairGalaxy}/${flairMode}`;
      valid = true;
    }
  }

  const reasons: string[] = [];
  if (!flairItem) {
    reasons.push("item");
  }
  if (!flairGalaxy) {
    reasons.push("galaxy");
  }
  if (THREE_PART_ITEMS.has(flairItem) && !flairMode) {
    reasons.push("game mode");
  }

  return { valid, normalizedText, reasons };
}

export function validateEventFlair(
  flairText: string | undefined,
  sourceText?: string | undefined,
): FlairValidationResult {
  const flair = flairText ?? "";
  const source = sourceText ?? "";
  const flairItem = flair.split("/")[0] ?? "";
  let flairGalaxy = matchFirst(flair, GALAXY_RULES);

  if (!flairGalaxy) {
    flairGalaxy = matchFirst(source, GALAXY_RULES);
  }

  const valid = Boolean(flairItem && flairGalaxy);
  const normalizedText = valid ? `${flairItem}/${flairGalaxy}` : "";
  const reasons: string[] = [];

  if (!flairItem) {
    reasons.push("item");
  }
  if (!flairGalaxy) {
    reasons.push("galaxy");
  }

  return { valid, normalizedText, reasons };
}
