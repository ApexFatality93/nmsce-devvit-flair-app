import { navigateTo, context, requestExpandedMode } from "@devvit/web/client";
const docsLink = document.getElementById("docs-link");
const playtestLink = document.getElementById("playtest-link");
const discordLink = document.getElementById("discord-link");
const startButton = document.getElementById("start-button");
startButton.addEventListener("click", (e) => {
    requestExpandedMode(e, "game");
});
docsLink.addEventListener("click", () => {
    navigateTo("https://developers.reddit.com/docs");
});
playtestLink.addEventListener("click", () => {
    navigateTo("https://www.reddit.com/r/Devvit");
});
discordLink.addEventListener("click", () => {
    navigateTo("https://discord.com/invite/R7yu2wh9Qz");
});
const titleElement = document.getElementById("title");
function init() {
    titleElement.textContent = `Hey ${context.username ?? "user"} 👋`;
}
init();
//# sourceMappingURL=splash.js.map