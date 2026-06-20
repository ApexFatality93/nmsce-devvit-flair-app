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
const DISCORD_EMBED_DESCRIPTION_LIMIT = 3800;

function normalizeThingId(id: string, prefix: "t1_" | "t3_"): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
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

function serializeDiscordDetails(details: Record<string, unknown>): string {
  return truncateForDiscord(
    JSON.stringify(details, null, 2),
    DISCORD_EMBED_DESCRIPTION_LIMIT,
  );
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
            description: `\`\`\`json\n${serializeDiscordDetails(details)}\n\`\`\``,
            color: 3447003,
            timestamp: new Date().toISOString(),
            fields: [
              ...(postUrl
                ? [
                    {
                      name: "Post",
                      value: `[Open post](${postUrl})`,
                      inline: true,
                    },
                  ]
                : []),
              ...(commentUrl
                ? [
                    {
                      name: "Comment",
                      value: `[Open comment](${commentUrl})`,
                      inline: true,
                    },
                  ]
                : []),
            ],
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
  postId: string,
  subredditName: string,
  flairTemplateId: string,
  flairText: string,
  title: string,
  body: string | undefined,
  authorName: string,
  preferredCommentBody?: string,
): Promise<string | null> {
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
    return result.normalizedText || flairText;
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
      return result.normalizedText || flairText;
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
      return result.normalizedText || flairText;
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
    return result.normalizedText;
  }

  return null;
}

async function maybeLeavePromptComment(
  postId: string,
  flairText: string,
  title: string,
  body: string | undefined,
): Promise<void> {
  const titleResult = validateEditableFlair(flairText, title);
  if (titleResult.valid) {
    return;
  }

  const combinedResult = validateEditableFlair(
    flairText,
    combineSourceParts(title, body),
  );
  if (combinedResult.valid) {
    return;
  }

  const missing =
    combinedResult.reasons.length <= titleResult.reasons.length
      ? combinedResult.reasons
      : titleResult.reasons;

  if (missing.length === 0) {
    return;
  }

  const bodyResult = validateEditableFlair(flairText, body);
  if (bodyResult.valid) {
    return;
  }

  const promptKey = `flair-prompt:${postId}`;
  const alreadyPrompted = await redis.get(promptKey);
  if (alreadyPrompted === "1") {
    console.log(`Prompt comment already left for ${postId}`);
    return;
  }

  const post = await reddit.getPostById(normalizeThingId(postId, "t3_"));
  const galaxyHelp = missing.includes("galaxy")
    ? " \n\nIf you need it, here is a [list of galaxy names](https://nomanssky.miraheze.org/wiki/Galaxy#List_of_Galaxies)"
    : "";
  const prompt =
    "Your post has been temporarily removed because its flair is missing required information. " +
    "Please reply to this comment with the missing detail and I will fix the flair automatically and restore the post. " +
    `\n\nMissing: ${missing.join(", ")}.` +
    galaxyHelp;
  await post.addComment({ text: prompt });
  await post.remove(false);
  await redis.set(promptKey, "1");
  await redis.expire(promptKey, PROMPT_COMMENT_TTL_SECONDS);
  console.log(`Left prompt comment and removed post ${postId}`);
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
  const payload = await readJSON<{
    post?: { id?: string };
  }>(req).catch(() => ({}));

  const postId = payload.post?.id ?? context.postId;

  if (!postId) {
    console.log("PostSubmit trigger hit with no postId in payload or context");
    return {};
  }

  const post = await reddit.getPostById(postId);
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
  await sendDiscordLog("PostSubmit trigger hit", {
    postId: post.id,
    subredditName: post.subredditName,
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
    const repairedFlair = await tryRepairEditableFlair(
      post.id,
      post.subredditName,
      flairTemplateId,
      flairText,
      post.title,
      post.body,
      post.authorName,
      undefined,
    );
    if (!repairedFlair) {
      await maybeLeavePromptComment(post.id, flairText, post.title, post.body);
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
      await sendDiscordLog("Updated event flair", {
        postId: post.id,
        subredditName: post.subredditName,
        title: post.title,
        flairTemplateId,
        flairText: result.normalizedText,
      });
    }
  }

  return {};
}

async function onCommentSubmit(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<{
    comment?: { id?: string; author?: string; body?: string; postId?: string };
    post?: { id?: string };
  }>(req).catch(() => ({}));

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
  await sendDiscordLog("CommentSubmit trigger hit", {
    postId: post.id,
    subredditName: post.subredditName,
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

  const repairedFlair = await tryRepairEditableFlair(
    post.id,
    post.subredditName,
    flairTemplateId,
    flairText,
    post.title,
    post.body,
    post.authorName,
    comment.body,
  );

  if (repairedFlair) {
    await post.approve();
    await comment.reply({
      text:
        `Your post flair has been updated to \`${repairedFlair}\` and your post has been restored.`,
    });
    console.log(`Approved post ${post.id} and left confirmation reply on comment ${comment.id}`);
    await sendDiscordLog("Approved post and confirmed flair repair", {
      postId: post.id,
      subredditName: post.subredditName,
      commentId: comment.id,
      flairTemplateId,
      repairedFlair,
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
