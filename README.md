## Devvit Hello World Starter

A starter to build web applications on Reddit's developer platform

- [Devvit](https://developers.reddit.com/): A way to build and deploy immersive games on Reddit
- [TypeScript](https://www.typescriptlang.org/): For type safety

## Getting Started

> Make sure you have Node 22 downloaded on your machine before running!

1. Run `npm create devvit@latest --template=hello-world`
2. Go through the installation wizard. You will need to create a Reddit account and connect it to Reddit developers
3. Copy the command on the success page into your terminal

## Commands

- `npm run dev`: Starts a development server where you can develop your application live on Reddit.
- `npm run build`: Builds your client and server projects
- `npm run deploy`: Uploads a new version of your app
- `npm run launch`: Publishes your app for review
- `npm run login`: Logs your CLI into Reddit
- `npm run type-check`: Type checks, lints, and prettifies your app

## NMSCE Flair App

This project is a Devvit app for `r/NMSCoordinateExchange` moderation.

### What It Does

- Validates editable NMSCE post flairs on post submit
- Repairs editable flairs automatically when the needed information can be found in the post title, post body, a triggering OP comment, or a previously known valid flair
- Validates and normalizes community event flairs
- Removes posts when required flair information is missing
- Leaves a prompt comment asking the OP for the missing flair details
- Restores and approves removed posts after the OP provides enough information to repair the flair
- Replies to confirm when a repaired flair caused a post to be restored
- Rechecks flair changes through the `PostFlairUpdate` trigger
- Sends Discord webhook embeds for major moderation and flair actions

### Subreddit Settings

The app currently supports these subreddit settings in `devvit.json`:

- `editable-flair-ids`: JSON object mapping editable flair template IDs to labels
- `community-event-flair-ids`: JSON object mapping community event flair template IDs to labels
- `discord-webhook-url`: optional Discord webhook for moderation and flair logs
- `removal-comment-template`: customizable comment template used when a post is removed for missing flair info
- `restoration-comment-template`: customizable comment template used when a repaired post is restored
- `request-flair-template-id`: optional flair template ID used by the moderator `!request` command

### Triggers

The app currently listens to:

- `onPostSubmit`
- `onCommentSubmit`
- `onPostFlairUpdate`

### Moderator Comment Commands

These commands are only honored when the comment author is a moderator of the subreddit where the comment was made.

- `!redirect`
  Posts a top-level redirect comment, removes the moderator command comment, removes the post, and logs the action to Discord.

- `!request`
  Changes the post to the configured Request flair template, removes the moderator command comment, posts a top-level request guidance comment, and logs the action to Discord.
  If `request-flair-template-id` is blank, this command does nothing.

### Request Flair Behavior

If the Request flair template ID is configured, the app also posts the same request guidance comment when a post's flair is manually changed to the Request flair template.

### Discord Logging

Discord webhook logging is designed to be human-readable and link back to Reddit directly.

Current logged actions include:

- editable flair repairs
- event flair normalization
- post removal for missing flair information
- post restoration after flair repair
- post redirect to the trading thread
- post being marked as Request

### Development Notes

- `npm run dev` uses `devvit playtest`
- `npm run deploy` runs `npm run build` and `devvit upload`
- `npm run launch` runs build, upload, and publish
- changes to `devvit.json` usually require restarting `npm run dev`

## Legal Pages

This repo now includes starter legal pages:

- `legal/privacy-policy.html`
- `legal/terms-and-conditions.html`

Before publishing, you should:

1. Replace the contact placeholders in both files with a real contact method.
2. Host the files at public URLs.
3. Paste those URLs into the Devvit app developer settings page.

### Easiest Way To Make Public URLs

The simplest option is usually GitHub Pages.

1. Push this repo to GitHub.
2. In the GitHub repository, open `Settings` -> `Pages`.
3. Set the source to deploy from your main branch and the `/root` folder.
4. Wait for GitHub Pages to publish the site.

If your GitHub username is `YOURNAME` and the repo is named `nmsce-flair-app`, the URLs will usually be:

- `https://YOURNAME.github.io/nmsce-flair-app/legal/privacy-policy.html`
- `https://YOURNAME.github.io/nmsce-flair-app/legal/terms-and-conditions.html`

Those are the URLs you can paste into:

- Privacy Policy
- Terms & Conditions

on your Devvit app settings page.

### Important Note

These pages are practical starter documents for this app, not formal legal advice. If you want stricter language for a business, team, or public commercial deployment, you should have them reviewed appropriately.
