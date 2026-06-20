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
const DISCORD_WEBHOOK_URL_SETTING = "discord-webhook-url";
const REMOVAL_COMMENT_TEMPLATE_SETTING = "removal-comment-template";
const RESTORATION_COMMENT_TEMPLATE_SETTING = "restoration-comment-template";
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_MAX_FIELDS = 25;
const DEFAULT_REMOVAL_COMMENT_TEMPLATE =
  "Your post has been temporarily removed because its flair is missing required information. " +
  "Please reply to this comment with the missing detail and I will fix the flair automatically and restore the post. " +
  "\n\nMissing: {{missing}}.{{galaxyHelp}}";
const DEFAULT_RESTORATION_COMMENT_TEMPLATE =
  "Your post flair has been updated to `{{repairedFlair}}` and your post has been restored.";

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
  | "triggering comment"
  | "existing OP comment"
  | "post body";
type FlairRepairResult = {
  normalizedFlair: string;
  source: FlairRepairSource;
  changed: boolean;
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
        formatInlineField("Subreddit", details.subredditName),
        formatInlineField("Post ID", details.postId),
        formatInlineField("Post Author", details.postAuthor),
        formatBlockField("Post Title", details.title),
        formatBlockField("Current Flair", details.flairText),
        formatBlockField("Missing Details", details.missing),
      );
      break;
    case "Editable flair repaired":
      fields.push(
        formatInlineField("Subreddit", details.subredditName),
        formatInlineField("Post ID", details.postId),
        formatInlineField("Repair Source", details.repairSource),
        formatInlineField("Flair Template ID", details.flairTemplateId),
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
      );
      break;
    case "Community event flair normalized":
      fields.push(
        formatInlineField("Subreddit", details.subredditName),
        formatInlineField("Post ID", details.postId),
        formatInlineField("Flair Template ID", details.flairTemplateId),
        formatBlockField("Post Title", details.title),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
      );
      break;
    case "Post restored after flair repair":
      fields.push(
        formatInlineField("Subreddit", details.subredditName),
        formatInlineField("Post ID", details.postId),
        formatInlineField("Comment ID", details.commentId),
        formatInlineField("Post Author", details.postAuthor),
        formatInlineField("Repair Source", details.repairSource),
        formatInlineField("Flair Template ID", details.flairTemplateId),
        formatBlockField(
          "Flair Change",
          buildFlairTransition(details.previousFlair, details.repairedFlair),
        ),
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
  preferredCommentBody?: string,
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

  if (preferredCommentBody) {
    result = validateEditableFlair(
      flairText,
      combineSourceParts(title, preferredCommentBody),
    );
    console.log(
      "Editable flair validation result from triggering comment",
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
        source: "triggering comment",
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
      undefined,
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
    comment.body,
  );

  if (repairResult) {
    await post.approve();
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
