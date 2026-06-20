import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis, settings } from "@devvit/web/server";
import type { TriggerResponse } from "@devvit/web/shared";
import {
  DEFAULT_COMMUNITY_EVENT_FLAIR_IDS,
  DEFAULT_EDITABLE_FLAIR_IDS,
} from "./flair-rules.ts";
import { validateEditableFlair, validateEventFlair } from "./flair-validator.ts";

type ErrorResponse = {
  error: string;
  status: number;
};

const PROMPT_COMMENT_TTL_SECONDS = 60 * 60 * 24 * 30;
const LAST_VALID_FLAIR_KEY_PREFIX = "last-valid-flair:";
const LAST_FLAIR_TEXT_KEY_PREFIX = "last-flair-text:";
const LAST_FLAIR_TEMPLATE_ID_KEY_PREFIX = "last-flair-template-id:";
const DISCORD_WEBHOOK_URL_SETTING = "discord-webhook-url";
const REMOVAL_COMMENT_TEMPLATE_SETTING = "removal-comment-template";
const RESTORATION_COMMENT_TEMPLATE_SETTING = "restoration-comment-template";
const REQUEST_FLAIR_TEMPLATE_ID_SETTING = "request-flair-template-id";
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_MAX_FIELDS = 25;
const DEFAULT_REMOVAL_COMMENT_TEMPLATE =
  "Your post has been temporarily removed because its flair is missing required information. " +
  "Please reply to this comment with the missing detail and I will fix the flair automatically and restore the post. " +
  "\n\nMissing: {{missing}}.{{galaxyHelp}}";
const DEFAULT_RESTORATION_COMMENT_TEMPLATE =
  "Your post flair has been updated to `{{repairedFlair}}` and your post has been restored.";
const REDIRECT_COMMAND = "!redirect";
const REQUEST_COMMAND = "!request";
const REDIRECT_COMMENT_TEXT =
  "Thank you for posting to r/NMSCoordinateExchange! Please make your request in the pinned trading post instead. " +
  "The trading thread was specifically created for requesting items that are generally not allowed as posts themselves. " +
  "See rule 8.";
const REQUEST_COMMENT_TEXT =
  "Many items are easy to find using the [search bar](https://www.reddit.com/r/NMSGlyphExchange/comments/1byxb6p/how_to_navigate_the_search_bar/) or the [nmsce app](https://nmsge.com/). Please search before posting a request. If you haven't searched and subsequently find your item upon searching please delete this post.\n\n" +
  "Posts requesting easily found items will be removed. Requests are only allowed for locations, not a trade, of items (excepting dragon eggs). Requests for expedition items are not allowed because they have no location.";

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

type PostThingId = `t3_${string}`;
type TriggerPostPayload = {
  post?: { id?: string };
};
type TriggerCommentPayload = {
  comment?: { id?: string; author?: string; body?: string; postId?: string };
  post?: { id?: string };
};
type FlairRepairSource =
  | "post title"
  | "previous flair"
  | "triggering comment"
  | "existing OP comment"
  | "post body";
type FlairRepairResult = {
  normalizedFlair: string;
  source: FlairRepairSource;
  changed: boolean;
};
type AdditionalRepairSource = {
  source: FlairRepairSource;
  text?: string;
};
type PromptCommentResult = {
  prompted: boolean;
  missing: string[];
};

function normalizeThingId<TPrefix extends "t1_" | "t3_">(
  id: string,
  prefix: TPrefix,
): `${TPrefix}${string}` {
  return (id.startsWith(prefix) ? id : `${prefix}${id}`) as `${TPrefix}${string}`;
}

function parseFlairIdMap(
  rawValue: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof key === "string" &&
        typeof value === "string" &&
        key.trim() &&
        value.trim()
      ) {
        normalized[key.trim()] = value.trim();
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

function combineSourceParts(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("\n");
}

function isDiscordWebhookUrl(value: string): boolean {
  return /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/.+/i.test(
    value,
  );
}

function truncateForDiscord(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}

function toDisplayText(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "string") {
    return value.trim() === "" ? "n/a" : value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return JSON.stringify(value);
}

function truncateFieldValue(value: string): string {
  return truncateForDiscord(value, DISCORD_FIELD_VALUE_LIMIT);
}

function formatInlineField(name: string, value: unknown): DiscordEmbedField {
  return {
    name,
    value: truncateFieldValue(toDisplayText(value)),
    inline: true,
  };
}

function formatBlockField(name: string, value: unknown): DiscordEmbedField {
  return {
    name,
    value: truncateFieldValue(toDisplayText(value)),
  };
}

function buildFlairTransition(before: unknown, after: unknown): string {
  return `${toDisplayText(before)} -> ${toDisplayText(after)}`;
}

function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

function getDiscordColor(title: string): number {
  switch (title) {
    case "Post removed for missing flair info":
      return 15105570;
    case "Editable flair repaired":
    case "Post restored after flair repair":
    case "Community event flair normalized":
      return 3066993;
    case "Post redirected to trading thread":
      return 15158332;
    case "Post marked as request":
      return 15844367;
    case "Post flair manually changed to request":
      return 15844367;
    default:
      return 3447003;
  }
}

function buildDiscordSummary(
  title: string,
  details: Record<string, unknown>,
): string {
  switch (title) {
    case "Post removed for missing flair info":
      return truncateForDiscord(
        `Removed the post and asked the author to reply with missing flair details: ${toDisplayText(details.missing)}.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Editable flair repaired":
      return truncateForDiscord(
        `Repaired editable flair from ${toDisplayText(details.repairSource)}.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Community event flair normalized":
      return truncateForDiscord(
        `Normalized a community event flair.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Post restored after flair repair":
      return truncateForDiscord(
        `Approved the post after the author provided enough info to repair the flair.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Post redirected to trading thread":
      return truncateForDiscord(
        `A moderator redirected the post to the pinned trading thread and removed the original post.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Post marked as request":
      return truncateForDiscord(
        `A moderator changed the post flair to Request and left request guidance on the post.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    case "Post flair manually changed to request":
      return truncateForDiscord(
        `The post flair was manually changed to Request and the app left request guidance on the post.`,
        DISCORD_EMBED_DESCRIPTION_LIMIT,
      );
    default:
      return truncateForDiscord(title, DISCORD_EMBED_DESCRIPTION_LIMIT);
  }
}

function buildDiscordFields(
  title: string,
  details: Record<string, unknown>,
  postUrl: string | null,
  commentUrl: string | null,
): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [];

  if (postUrl) {
    fields.push({
      name: "Reddit Post",
      value: `[Open post](${postUrl})`,
      inline: true,
    });
  }

  if (commentUrl) {
    fields.push({
      name: "Reddit Comment",
      value: `[Open comment](${commentUrl})`,
      inline: true,
    });
  }

  switch (title) {
    case "Post removed for missing flair info":
      fields.push(
        formatInlineField("Post Author", details.postAuthor),
        formatBlockField("Post Title", details.title),
        formatBlockField("Current Flair", details.flairText),
        formatBlockField("Missing Details", details.missing),
      );
      break;
    case "Editable flair repaired":
      fields.push(
        formatInlineField("Repair Source", details.repairSource),
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
      );
      break;
    case "Community event flair normalized":
      fields.push(
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
      );
      break;
    case "Post restored after flair repair":
      fields.push(
        formatInlineField("Post Author", details.postAuthor),
        formatInlineField("Repair Source", details.repairSource),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
      );
      break;
    case "Post redirected to trading thread":
      fields.push(
        formatInlineField("Moderator", details.moderatorName),
        formatInlineField("Post Author", details.postAuthor),
        formatBlockField("Post Title", details.title),
        formatBlockField("Action", "Top-level redirect comment posted; mod command comment removed; post removed."),
      );
      break;
    case "Post marked as request":
      fields.push(
        formatInlineField("Moderator", details.moderatorName),
        formatInlineField("Post Author", details.postAuthor),
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
        formatBlockField("Action", "Request flair applied; mod command comment removed; top-level request guidance comment posted."),
      );
      break;
    case "Post flair manually changed to request":
      fields.push(
        formatInlineField("Post Author", details.postAuthor),
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
        formatBlockField("Action", "Top-level request guidance comment posted after a manual flair change to Request."),
      );
      break;
    default:
      for (const [name, value] of Object.entries(details)) {
        fields.push(formatBlockField(name, value));
      }
      break;
  }

  return fields
    .filter((field) => field.value.trim() !== "")
    .slice(0, DISCORD_MAX_FIELDS);
}

function stripThingPrefix(id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }

  return id.replace(/^t[13]_/, "");
}

function buildRedditPostUrl(
  subredditName: string | null | undefined,
  postId: string | null | undefined,
): string | null {
  const cleanSubredditName = subredditName?.trim();
  const cleanPostId = stripThingPrefix(postId);

  if (!cleanSubredditName || !cleanPostId) {
    return null;
  }

  return `https://www.reddit.com/r/${cleanSubredditName}/comments/${cleanPostId}/`;
}

function buildRedditCommentUrl(
  subredditName: string | null | undefined,
  postId: string | null | undefined,
  commentId: string | null | undefined,
): string | null {
  const postUrl = buildRedditPostUrl(subredditName, postId);
  const cleanCommentId = stripThingPrefix(commentId);

  if (!postUrl || !cleanCommentId) {
    return null;
  }

  return `${postUrl}-/${cleanCommentId}/?context=3`;
}

async function getDiscordWebhookUrl(): Promise<string | null> {
  const rawValue = await settings.get(DISCORD_WEBHOOK_URL_SETTING);
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmedValue = rawValue.trim();
  if (!trimmedValue || !isDiscordWebhookUrl(trimmedValue)) {
    return null;
  }

  return trimmedValue;
}

async function getSettingStringWithDefault(
  key: string,
  fallback: string,
): Promise<string> {
  const rawValue = await settings.get(key);
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const trimmedValue = rawValue.trim();
  return trimmedValue === "" ? fallback : rawValue;
}

async function getRemovalCommentTemplate(): Promise<string> {
  return getSettingStringWithDefault(
    REMOVAL_COMMENT_TEMPLATE_SETTING,
    DEFAULT_REMOVAL_COMMENT_TEMPLATE,
  );
}

async function getRestorationCommentTemplate(): Promise<string> {
  return getSettingStringWithDefault(
    RESTORATION_COMMENT_TEMPLATE_SETTING,
    DEFAULT_RESTORATION_COMMENT_TEMPLATE,
  );
}

function isRedirectCommand(commentBody: string | undefined): boolean {
  return commentBody?.trim().toLowerCase() === REDIRECT_COMMAND;
}

async function getRequestFlairTemplateId(): Promise<string | null> {
  const rawValue = await settings.get(REQUEST_FLAIR_TEMPLATE_ID_SETTING);
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmedValue = rawValue.trim();
  return trimmedValue === "" ? null : trimmedValue;
}

function isRequestCommand(commentBody: string | undefined): boolean {
  return commentBody?.trim().toLowerCase() === REQUEST_COMMAND;
}

async function isSubredditModerator(
  subredditName: string,
  username: string | null | undefined,
): Promise<boolean> {
  if (!username?.trim()) {
    return false;
  }

  const moderators = await reddit
    .getModerators({
      subredditName,
      username,
      limit: 1,
      pageSize: 1,
    })
    .all();

  return moderators.some(
    (moderator) => moderator.username.toLowerCase() === username.toLowerCase(),
  );
}

async function getFlairTemplateText(
  subredditName: string,
  flairTemplateId: string,
): Promise<string | null> {
  const subreddit = await reddit.getSubredditByName(subredditName);
  const templates = await subreddit.getPostFlairTemplates();
  const template = templates.find((item) => item.id === flairTemplateId);
  return template?.text ?? null;
}

function getLastValidFlairKey(postId: string): string {
  return `${LAST_VALID_FLAIR_KEY_PREFIX}${postId}`;
}

function getLastFlairTextKey(postId: string): string {
  return `${LAST_FLAIR_TEXT_KEY_PREFIX}${postId}`;
}

function getLastFlairTemplateIdKey(postId: string): string {
  return `${LAST_FLAIR_TEMPLATE_ID_KEY_PREFIX}${postId}`;
}

async function getLastValidFlair(postId: string): Promise<string | null> {
  const value = await redis.get(getLastValidFlairKey(postId));
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value;
}

async function setLastValidFlair(postId: string, flairText: string): Promise<void> {
  if (!flairText.trim()) {
    return;
  }

  await redis.set(getLastValidFlairKey(postId), flairText);
}

async function getLastFlairText(postId: string): Promise<string | null> {
  const value = await redis.get(getLastFlairTextKey(postId));
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value;
}

async function setLastFlairText(postId: string, flairText: string): Promise<void> {
  if (!flairText.trim()) {
    return;
  }

  await redis.set(getLastFlairTextKey(postId), flairText);
}

async function getLastFlairTemplateId(postId: string): Promise<string | null> {
  const value = await redis.get(getLastFlairTemplateIdKey(postId));
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value;
}

async function setLastFlairTemplateId(
  postId: string,
  flairTemplateId: string | null | undefined,
): Promise<void> {
  if (!flairTemplateId?.trim()) {
    return;
  }

  await redis.set(getLastFlairTemplateIdKey(postId), flairTemplateId);
}

async function sendDiscordLog(
  title: string,
  details: Record<string, unknown>,
): Promise<void> {
  const webhookUrl = await getDiscordWebhookUrl();
  if (!webhookUrl) {
    return;
  }

  const subredditName =
    typeof details.subredditName === "string" ? details.subredditName : null;
  const postId = typeof details.postId === "string" ? details.postId : null;
  const commentId =
    typeof details.commentId === "string" ? details.commentId : null;
  const postUrl = buildRedditPostUrl(subredditName, postId);
  const commentUrl = buildRedditCommentUrl(subredditName, postId, commentId);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        embeds: [
          {
            title,
            url: postUrl ?? undefined,
            description: buildDiscordSummary(title, details),
            color: getDiscordColor(title),
            timestamp: new Date().toISOString(),
            fields: buildDiscordFields(title, details, postUrl, commentUrl),
          },
        ],
      }),
    });

    if (!response.ok) {
      console.log(`Discord webhook log failed with status ${response.status}`);
    }
  } catch (error) {
    console.log(`Discord webhook log failed: ${String(error)}`);
  }
}

async function tryRepairEditableFlair(
  postId: PostThingId,
  subredditName: string,
  flairTemplateId: string,
  flairText: string,
  title: string,
  body: string | undefined,
  authorName: string,
  additionalRepairSources: AdditionalRepairSource[] = [],
): Promise<FlairRepairResult | null> {
  let result = validateEditableFlair(flairText, title);
  console.log("Editable flair validation result from title", result);

  if (result.valid) {
    if (result.normalizedText !== flairText) {
      await reddit.setPostFlair({
        postId,
        subredditName,
        flairTemplateId,
        text: result.normalizedText,
      });
      console.log(`Updated editable flair for ${postId} to ${result.normalizedText}`);
    }
    return {
      normalizedFlair: result.normalizedText || flairText,
      source: "post title",
      changed: result.normalizedText !== flairText,
    };
  }

  for (const additionalSource of additionalRepairSources) {
    if (!additionalSource.text?.trim()) {
      continue;
    }

    result = validateEditableFlair(
      flairText,
      combineSourceParts(title, additionalSource.text),
    );
    console.log(
      `Editable flair validation result from ${additionalSource.source}`,
      result,
    );

    if (result.valid) {
      if (result.normalizedText !== flairText) {
        await reddit.setPostFlair({
          postId,
          subredditName,
          flairTemplateId,
          text: result.normalizedText,
        });
        console.log(`Updated editable flair for ${postId} to ${result.normalizedText}`);
      }
      return {
        normalizedFlair: result.normalizedText || flairText,
        source: additionalSource.source,
        changed: result.normalizedText !== flairText,
      };
    }
  }

  const comments = await reddit.getComments({
    postId,
    limit: 100,
    depth: 10,
    sort: "new",
  }).all();
  console.log(`Loaded ${comments.length} comments for ${postId}`);

  for (const comment of comments) {
    if (comment.authorName !== authorName) {
      continue;
    }

    result = validateEditableFlair(
      flairText,
      combineSourceParts(title, comment.body),
    );
    console.log("Editable flair validation result from OP comment", result);

    if (result.valid) {
      if (result.normalizedText !== flairText) {
        await reddit.setPostFlair({
          postId,
          subredditName,
          flairTemplateId,
          text: result.normalizedText,
        });
        console.log(`Updated editable flair for ${postId} to ${result.normalizedText}`);
      }
      return {
        normalizedFlair: result.normalizedText || flairText,
        source: "existing OP comment",
        changed: result.normalizedText !== flairText,
      };
    }
  }

  result = validateEditableFlair(flairText, combineSourceParts(title, body));
  console.log("Editable flair validation result from post body", result);

  if (result.valid && result.normalizedText !== flairText) {
    await reddit.setPostFlair({
      postId,
      subredditName,
      flairTemplateId,
      text: result.normalizedText,
    });
    console.log(`Updated editable flair for ${postId} to ${result.normalizedText}`);
    return {
      normalizedFlair: result.normalizedText,
      source: "post body",
      changed: true,
    };
  }

  return null;
}

async function maybeLeavePromptComment(
  postId: PostThingId,
  subredditName: string,
  flairText: string,
  title: string,
  body: string | undefined,
): Promise<PromptCommentResult> {
  const titleResult = validateEditableFlair(flairText, title);
  if (titleResult.valid) {
    return { prompted: false, missing: [] };
  }

  const combinedResult = validateEditableFlair(
    flairText,
    combineSourceParts(title, body),
  );
  if (combinedResult.valid) {
    return { prompted: false, missing: [] };
  }

  const missing =
    combinedResult.reasons.length <= titleResult.reasons.length
      ? combinedResult.reasons
      : titleResult.reasons;

  if (missing.length === 0) {
    return { prompted: false, missing: [] };
  }

  const bodyResult = validateEditableFlair(flairText, body);
  if (bodyResult.valid) {
    return { prompted: false, missing: [] };
  }

  const promptKey = `flair-prompt:${postId}`;
  const alreadyPrompted = await redis.get(promptKey);
  if (alreadyPrompted === "1") {
    console.log(`Prompt comment already left for ${postId}`);
    return { prompted: false, missing };
  }

  const post = await reddit.getPostById(normalizeThingId(postId, "t3_"));
  const galaxyHelp = missing.includes("galaxy")
    ? " \n\nIf you need it, here is a [list of galaxy names](https://nomanssky.miraheze.org/wiki/Galaxy#List_of_Galaxies)"
    : "";
  const removalTemplate = await getRemovalCommentTemplate();
  const prompt = fillTemplate(removalTemplate, {
    missing: missing.join(", "),
    galaxyHelp,
    subredditName,
    postId,
    flairText,
    title,
  });
  await post.addComment({ text: prompt });
  await post.remove(false);
  await redis.set(promptKey, "1");
  await redis.expire(promptKey, PROMPT_COMMENT_TTL_SECONDS);
  console.log(`Left prompt comment and removed post ${postId}`);
  return { prompted: true, missing };
}

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON<ErrorResponse>(500, { error: msg, status: 500 }, rsp);
  }
}

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const url = req.url;

  if (url === "/internal/triggers/post-submit") {
    const body = await onPostSubmit(req);
    writeJSON<TriggerResponse>(200, body, rsp);
    return;
  }

  if (url === "/internal/triggers/comment-submit") {
    const body = await onCommentSubmit(req);
    writeJSON<TriggerResponse>(200, body, rsp);
    return;
  }

  if (url === "/internal/triggers/post-flair-update") {
    const body = await onPostFlairUpdate(req);
    writeJSON<TriggerResponse>(200, body, rsp);
    return;
  }

  writeJSON<ErrorResponse>(404, { error: "not found", status: 404 }, rsp);
}

async function onPostSubmit(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<TriggerPostPayload>(req).catch(
    (): TriggerPostPayload => ({}),
  );

  const postId = payload.post?.id ?? context.postId;

  if (!postId) {
    console.log("PostSubmit trigger hit with no postId in payload or context");
    return {};
  }

  const post = await reddit.getPostById(normalizeThingId(postId, "t3_"));
  const rawEditableFlairIds = await settings.get("editable-flair-ids");
  const rawCommunityEventFlairIds = await settings.get(
    "community-event-flair-ids",
  );
  const editableFlairIds = parseFlairIdMap(
    rawEditableFlairIds,
    DEFAULT_EDITABLE_FLAIR_IDS,
  );
  const communityEventFlairIds = parseFlairIdMap(
    rawCommunityEventFlairIds,
    DEFAULT_COMMUNITY_EVENT_FLAIR_IDS,
  );
  console.log("PostSubmit trigger hit", {
    postId: post.id,
    title: post.title,
    flairTemplateId: post.flair?.templateId ?? null,
    flairText: post.flair?.text ?? null,
    editableFlairConfigured: Boolean(
      post.flair?.templateId && editableFlairIds[post.flair.templateId],
    ),
    communityEventConfigured: Boolean(
      post.flair?.templateId &&
        communityEventFlairIds[post.flair.templateId],
    ),
  });
  const flairTemplateId = post.flair?.templateId;
  const flairText = post.flair?.text ?? "";

  await setLastFlairText(post.id, flairText);
  await setLastFlairTemplateId(post.id, flairTemplateId);

  if (!flairTemplateId) {
    console.log("Skipping post with no flair template ID");
    return {};
  }

  if (editableFlairIds[flairTemplateId]) {
    const repairResult = await tryRepairEditableFlair(
      post.id,
      post.subredditName,
      flairTemplateId,
      flairText,
      post.title,
      post.body,
      post.authorName,
      [],
    );
    if (repairResult?.changed) {
      await sendDiscordLog("Editable flair repaired", {
        postId: post.id,
        subredditName: post.subredditName,
        title: post.title,
        flairTemplateId,
        previousFlair: flairText,
        repairedFlair: repairResult.normalizedFlair,
        repairSource: repairResult.source,
      });
    }
    if (repairResult) {
      await setLastValidFlair(post.id, repairResult.normalizedFlair);
    }
    if (!repairResult) {
      const promptResult = await maybeLeavePromptComment(
        post.id,
        post.subredditName,
        flairText,
        post.title,
        post.body,
      );
      if (promptResult.prompted) {
        await sendDiscordLog("Post removed for missing flair info", {
          postId: post.id,
          subredditName: post.subredditName,
          postAuthor: post.authorName,
          title: post.title,
          flairText,
          missing: promptResult.missing.join(", "),
        });
      }
    }
    return {};
  }

  if (communityEventFlairIds[flairTemplateId]) {
    const result = validateEventFlair(flairText);
    console.log("Community event flair validation result", result);

    if (result.valid && result.normalizedText !== flairText) {
      await reddit.setPostFlair({
        postId: post.id,
        subredditName: post.subredditName,
        flairTemplateId,
        text: result.normalizedText,
      });
      console.log(`Updated event flair for ${post.id} to ${result.normalizedText}`);
      await sendDiscordLog("Community event flair normalized", {
        postId: post.id,
        subredditName: post.subredditName,
        title: post.title,
        flairTemplateId,
        previousFlair: flairText,
        repairedFlair: result.normalizedText,
      });
      await setLastValidFlair(post.id, result.normalizedText);
    } else if (result.valid) {
      await setLastValidFlair(post.id, result.normalizedText);
    }
  }

  return {};
}

async function onCommentSubmit(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<TriggerCommentPayload>(req).catch(
    (): TriggerCommentPayload => ({}),
  );

  const commentId = payload.comment?.id;
  const postId = payload.post?.id ?? payload.comment?.postId ?? context.postId;

  if (!postId) {
    console.log("CommentSubmit trigger hit with no postId in payload or context");
    return {};
  }

  const post = await reddit.getPostById(normalizeThingId(postId, "t3_"));
  const comment = commentId
    ? await reddit.getCommentById(normalizeThingId(commentId, "t1_"))
    : null;
  const rawEditableFlairIds = await settings.get("editable-flair-ids");
  const editableFlairIds = parseFlairIdMap(
    rawEditableFlairIds,
    DEFAULT_EDITABLE_FLAIR_IDS,
  );

  console.log("CommentSubmit trigger hit", {
    postId: post.id,
    commentId: commentId ?? null,
    payloadCommentAuthor: payload.comment?.author ?? null,
    commentAuthor: comment?.authorName ?? null,
    postAuthor: post.authorName,
    flairTemplateId: post.flair?.templateId ?? null,
    flairText: post.flair?.text ?? null,
    editableFlairConfigured: Boolean(
      post.flair?.templateId && editableFlairIds[post.flair.templateId],
    ),
  });
  const flairTemplateId = post.flair?.templateId;
  const flairText = post.flair?.text ?? "";

  if (
    comment &&
    isRedirectCommand(comment.body) &&
    (await isSubredditModerator(post.subredditName, comment.authorName))
  ) {
    await post.addComment({ text: REDIRECT_COMMENT_TEXT });
    await comment.remove(false);
    await post.remove(false);
    console.log(
      `Posted redirect comment on ${post.id} from moderator command on ${comment.id}`,
    );
    await sendDiscordLog("Post redirected to trading thread", {
      postId: post.id,
      subredditName: post.subredditName,
      commentId: comment.id,
      moderatorName: comment.authorName,
      postAuthor: post.authorName,
      title: post.title,
    });
    return {};
  }

  if (
    comment &&
    isRequestCommand(comment.body) &&
    (await isSubredditModerator(post.subredditName, comment.authorName))
  ) {
    const requestFlairTemplateId = await getRequestFlairTemplateId();
    if (!requestFlairTemplateId) {
      console.log("Ignoring !request command because request flair template ID is not configured");
      return {};
    }

    const requestFlairText =
      (await getFlairTemplateText(post.subredditName, requestFlairTemplateId)) ?? undefined;

    await reddit.setPostFlair({
      postId: post.id,
      subredditName: post.subredditName,
      flairTemplateId: requestFlairTemplateId,
      text: requestFlairText,
    });
    await setLastValidFlair(post.id, requestFlairText ?? "Request");
    await setLastFlairText(post.id, requestFlairText ?? "Request");
    await setLastFlairTemplateId(post.id, requestFlairTemplateId);
    await comment.remove(false);
    await post.addComment({ text: REQUEST_COMMENT_TEXT });
    console.log(
      `Applied request flair on ${post.id} from moderator command on ${comment.id}`,
    );
    await sendDiscordLog("Post marked as request", {
      postId: post.id,
      subredditName: post.subredditName,
      commentId: comment.id,
      moderatorName: comment.authorName,
      postAuthor: post.authorName,
      title: post.title,
      previousFlair: flairText,
      repairedFlair: requestFlairText ?? "Request",
    });
    return {};
  }

  if (!flairTemplateId || !editableFlairIds[flairTemplateId]) {
    return {};
  }

  if (!comment || comment.authorName !== post.authorName) {
    console.log("Skipping comment submit because commenter is not the post author");
    return {};
  }

  const currentFlairIsValid = validateEditableFlair(flairText, post.title);
  if (
    currentFlairIsValid.valid &&
    currentFlairIsValid.normalizedText === flairText
  ) {
    console.log("Skipping comment submit because flair is already valid");
    return {};
  }

  const repairResult = await tryRepairEditableFlair(
    post.id,
    post.subredditName,
    flairTemplateId,
    flairText,
    post.title,
    post.body,
    post.authorName,
    [{ source: "triggering comment", text: comment.body }],
  );

  if (repairResult) {
    await post.approve();
    await setLastValidFlair(post.id, repairResult.normalizedFlair);
    const restorationTemplate = await getRestorationCommentTemplate();
    await comment.reply({
      text: fillTemplate(restorationTemplate, {
        repairedFlair: repairResult.normalizedFlair,
        subredditName: post.subredditName,
        postId: post.id,
        commentId: comment.id,
        flairText,
        previousFlair: flairText,
        title: post.title,
      }),
    });
    console.log(`Approved post ${post.id} and left confirmation reply on comment ${comment.id}`);
    await sendDiscordLog("Post restored after flair repair", {
      postId: post.id,
      subredditName: post.subredditName,
      commentId: comment.id,
      flairTemplateId,
      previousFlair: flairText,
      repairedFlair: repairResult.normalizedFlair,
      repairSource: repairResult.source,
      postAuthor: post.authorName,
    });
  }

  return {};
}

async function onPostFlairUpdate(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<TriggerPostPayload>(req).catch(
    (): TriggerPostPayload => ({}),
  );

  const postId = payload.post?.id ?? context.postId;

  if (!postId) {
    console.log("PostFlairUpdate trigger hit with no postId in payload or context");
    return {};
  }

  const post = await reddit.getPostById(normalizeThingId(postId, "t3_"));
  const rawEditableFlairIds = await settings.get("editable-flair-ids");
  const rawCommunityEventFlairIds = await settings.get(
    "community-event-flair-ids",
  );
  const editableFlairIds = parseFlairIdMap(
    rawEditableFlairIds,
    DEFAULT_EDITABLE_FLAIR_IDS,
  );
  const communityEventFlairIds = parseFlairIdMap(
    rawCommunityEventFlairIds,
    DEFAULT_COMMUNITY_EVENT_FLAIR_IDS,
  );

  const flairTemplateId = post.flair?.templateId;
  const flairText = post.flair?.text ?? "";
  const previousValidFlair = await getLastValidFlair(post.id);
  const previousFlairText = await getLastFlairText(post.id);
  const previousFlairTemplateId = await getLastFlairTemplateId(post.id);
  const requestFlairTemplateId = await getRequestFlairTemplateId();

  console.log("PostFlairUpdate trigger hit", {
    postId: post.id,
    title: post.title,
    flairTemplateId,
    flairText,
    previousValidFlair,
    previousFlairText,
    previousFlairTemplateId,
    editableFlairConfigured: Boolean(
      flairTemplateId && editableFlairIds[flairTemplateId],
    ),
    communityEventConfigured: Boolean(
      flairTemplateId && communityEventFlairIds[flairTemplateId],
    ),
  });

  if (!flairTemplateId) {
    console.log("Skipping flair update with no flair template ID");
    return {};
  }

  if (
    requestFlairTemplateId &&
    flairTemplateId === requestFlairTemplateId &&
    previousFlairTemplateId !== requestFlairTemplateId
  ) {
    const requestFlairText =
      (await getFlairTemplateText(post.subredditName, requestFlairTemplateId)) ?? "Request";
    await post.addComment({ text: REQUEST_COMMENT_TEXT });
    await sendDiscordLog("Post flair manually changed to request", {
      postId: post.id,
      subredditName: post.subredditName,
      postAuthor: post.authorName,
      title: post.title,
      previousFlair: previousFlairText ?? previousValidFlair ?? "n/a",
      repairedFlair: requestFlairText,
    });
    await setLastValidFlair(post.id, requestFlairText);
    await setLastFlairText(post.id, requestFlairText);
    await setLastFlairTemplateId(post.id, requestFlairTemplateId);
    return {};
  }

  if (editableFlairIds[flairTemplateId]) {
    const repairSources: AdditionalRepairSource[] = previousValidFlair
      ? [{ source: "previous flair", text: previousValidFlair }]
      : [];
    const repairResult = await tryRepairEditableFlair(
      post.id,
      post.subredditName,
      flairTemplateId,
      flairText,
      post.title,
      post.body,
      post.authorName,
      repairSources,
    );

    if (repairResult?.changed) {
      await sendDiscordLog("Editable flair repaired", {
        postId: post.id,
        subredditName: post.subredditName,
        title: post.title,
        flairTemplateId,
        previousFlair: previousValidFlair ?? flairText,
        repairedFlair: repairResult.normalizedFlair,
        repairSource: repairResult.source,
      });
    }

    if (repairResult) {
      await setLastValidFlair(post.id, repairResult.normalizedFlair);
      await setLastFlairText(post.id, repairResult.normalizedFlair);
      await setLastFlairTemplateId(post.id, flairTemplateId);
    } else {
      const promptResult = await maybeLeavePromptComment(
        post.id,
        post.subredditName,
        flairText,
        post.title,
        post.body,
      );
      if (promptResult.prompted) {
        await sendDiscordLog("Post removed for missing flair info", {
          postId: post.id,
          subredditName: post.subredditName,
          postAuthor: post.authorName,
          title: post.title,
          flairText,
          missing: promptResult.missing.join(", "),
        });
      }
      await setLastFlairText(post.id, flairText);
      await setLastFlairTemplateId(post.id, flairTemplateId);
    }

    return {};
  }

  if (communityEventFlairIds[flairTemplateId]) {
    const result = validateEventFlair(flairText, previousValidFlair ?? undefined);
    console.log("Community event flair validation result from flair update", result);

    if (result.valid && result.normalizedText !== flairText) {
      await reddit.setPostFlair({
        postId: post.id,
        subredditName: post.subredditName,
        flairTemplateId,
        text: result.normalizedText,
      });
      console.log(`Updated event flair for ${post.id} to ${result.normalizedText}`);
      await sendDiscordLog("Community event flair normalized", {
        postId: post.id,
        subredditName: post.subredditName,
        title: post.title,
        flairTemplateId,
        previousFlair: previousValidFlair ?? flairText,
        repairedFlair: result.normalizedText,
      });
      await setLastValidFlair(post.id, result.normalizedText);
      await setLastFlairText(post.id, result.normalizedText);
      await setLastFlairTemplateId(post.id, flairTemplateId);
    } else if (result.valid) {
      await setLastValidFlair(post.id, result.normalizedText);
      await setLastFlairText(post.id, result.normalizedText);
      await setLastFlairTemplateId(post.id, flairTemplateId);
    }
  }

  await setLastFlairText(post.id, flairText);
  await setLastFlairTemplateId(post.id, flairTemplateId);

  return {};
}

function writeJSON<T>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, {
    "Content-Length": len,
    "Content-Type": "application/json",
  });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    req.on("end", () => resolve());
    req.on("error", (err) => reject(err));
  });
  return JSON.parse(`${Buffer.concat(chunks)}`) as T;
}
